import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'
import artifactClient from '@actions/artifact'
import type {Artifact, FindOptions} from '@actions/artifact'
import {Minimatch} from 'minimatch'
import {Inputs, Outputs, DigestMismatchBehavior} from './constants.js'

const PARALLEL_DOWNLOADS = 5
const MANIFEST_PREFIX = '.artifact_upload_manifest.'
const MANIFEST_SUFFIX = '.json'

const isManifestName = (name: string): boolean =>
  name.startsWith(MANIFEST_PREFIX) &&
  name.endsWith(MANIFEST_SUFFIX) &&
  name.length > MANIFEST_PREFIX.length + MANIFEST_SUFFIX.length

class ManifestFormatError extends Error {}

// Maps artifact name -> original relative path, as written by upload-artifact
async function readManifest(
  manifestArtifact: Artifact,
  options: FindOptions,
  digestMismatch: DigestMismatchBehavior
): Promise<Map<string, string>> {
  const dir = await fs.mkdtemp(
    path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), 'download-manifest-')
  )
  try {
    const outcome = await artifactClient.downloadArtifact(manifestArtifact.id, {
      ...options,
      path: dir,
      expectedHash: manifestArtifact.digest
    })
    if (outcome.digestMismatch) {
      const message = `Manifest '${manifestArtifact.name}' digest validation failed. Please verify the integrity of the artifact.`
      if (digestMismatch === DigestMismatchBehavior.Error) {
        throw new Error(message)
      }
      if (digestMismatch === DigestMismatchBehavior.Warn) {
        core.warning(message)
      } else if (digestMismatch === DigestMismatchBehavior.Info) {
        core.info(message)
      }
    }
    let manifest
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(dir, manifestArtifact.name), 'utf8')
      )
    } catch (error) {
      throw new ManifestFormatError(
        `Unable to read manifest '${manifestArtifact.name}': ${(error as Error).message}`
      )
    }
    if (manifest?.version !== 1 || !Array.isArray(manifest.files)) {
      throw new ManifestFormatError(
        `Manifest '${manifestArtifact.name}' has an unsupported format`
      )
    }
    const map = new Map<string, string>()
    for (const entry of manifest.files) {
      if (
        typeof entry?.artifact !== 'string' ||
        typeof entry?.path !== 'string' ||
        !entry.path
      ) {
        throw new ManifestFormatError(
          `Manifest '${manifestArtifact.name}' contains an invalid entry`
        )
      }
      map.set(entry.artifact, entry.path)
    }
    return map
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
}

// Combines the manifests of every upload-artifact group found in the run.
// A manifest we cannot understand is skipped so it can't break unrelated downloads.
async function readAllManifests(
  allArtifacts: Artifact[],
  options: FindOptions,
  digestMismatch: DigestMismatchBehavior
): Promise<Map<string, string>> {
  const restorePaths = new Map<string, string>()
  for (const manifestArtifact of allArtifacts.filter(a =>
    isManifestName(a.name)
  )) {
    core.info(`Reading upload manifest '${manifestArtifact.name}'`)
    try {
      const entries = await readManifest(
        manifestArtifact,
        options,
        digestMismatch
      )
      core.debug(
        `Manifest '${manifestArtifact.name}' lists ${entries.size} file(s)`
      )
      entries.forEach((p, name) => restorePaths.set(name, p))
    } catch (error) {
      if (!(error instanceof ManifestFormatError)) throw error
      core.warning(`${error.message}. Ignoring this manifest.`)
    }
  }
  return restorePaths
}

// Resolves a manifest path, refusing anything that would escape the destination
function resolveRestorePath(root: string, relative: string): string {
  const dest = path.resolve(root, ...relative.split('/'))
  const fromRoot = path.relative(root, dest)
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new Error(`Manifest path '${relative}' escapes the download path`)
  }
  return dest
}

// Copies a downloaded file to dest without writing through symlinks that
// would lead outside the download path
async function copyRestoredFile(
  root: string,
  dest: string,
  source: string
): Promise<void> {
  await fs.mkdir(path.dirname(dest), {recursive: true})
  const realRoot = await fs.realpath(root)
  const realParent = await fs.realpath(path.dirname(dest))
  const fromRoot = path.relative(realRoot, realParent)
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new Error(
      `'${dest}' resolves outside the download path via a symlink`
    )
  }
  const existing = await fs.lstat(dest).catch(() => undefined)
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink '${dest}'`)
  }
  await fs.copyFile(source, dest)
}

export const chunk = <T>(arr: T[], n: number): T[][] =>
  arr.reduce((acc, cur, i) => {
    const index = Math.floor(i / n)
    acc[index] = [...(acc[index] || []), cur]
    return acc
  }, [] as T[][])

export async function run(): Promise<void> {
  const inputs = {
    name: core.getInput(Inputs.Name, {required: false}),
    path: core.getInput(Inputs.Path, {required: false}),
    token: core.getInput(Inputs.GitHubToken, {required: false}),
    repository: core.getInput(Inputs.Repository, {required: false}),
    runID: parseInt(core.getInput(Inputs.RunID, {required: false})),
    pattern: core.getInput(Inputs.Pattern, {required: false}),
    mergeMultiple: core.getBooleanInput(Inputs.MergeMultiple, {
      required: false
    }),
    artifactIds: core.getInput(Inputs.ArtifactIds, {required: false}),
    skipDecompress: core.getBooleanInput(Inputs.SkipDecompress, {
      required: false
    }),
    digestMismatch: (core.getInput(Inputs.DigestMismatch, {required: false}) ||
      DigestMismatchBehavior.Error) as DigestMismatchBehavior
  }

  // Validate digest-mismatch input
  const validBehaviors = Object.values(DigestMismatchBehavior)
  if (!validBehaviors.includes(inputs.digestMismatch)) {
    throw new Error(
      `Invalid value for 'digest-mismatch': '${inputs.digestMismatch}'. Valid options are: ${validBehaviors.join(', ')}`
    )
  }

  if (!inputs.path) {
    inputs.path = process.env['GITHUB_WORKSPACE'] || process.cwd()
  }

  if (inputs.path.startsWith(`~`)) {
    inputs.path = inputs.path.replace('~', os.homedir())
  }

  // Check for mutually exclusive inputs
  if (inputs.name && inputs.artifactIds) {
    throw new Error(
      `Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.`
    )
  }

  const isSingleArtifactDownload = !!inputs.name
  const isDownloadByIds = !!inputs.artifactIds
  const resolvedPath = path.resolve(inputs.path)
  core.debug(`Resolved path is ${resolvedPath}`)

  const options: FindOptions = {}
  if (inputs.token) {
    const [repositoryOwner, repositoryName] = inputs.repository.split('/')
    if (!repositoryOwner || !repositoryName) {
      throw new Error(
        `Invalid repository: '${inputs.repository}'. Must be in format owner/repo`
      )
    }

    options.findBy = {
      token: inputs.token,
      workflowRunId: inputs.runID,
      repositoryName,
      repositoryOwner
    }
  }

  let artifacts: Artifact[] = []
  let artifactIds: number[] = []
  let manifestPaths = new Map<string, string>()

  if (isSingleArtifactDownload) {
    core.info(`Downloading single artifact`)

    const {artifact: targetArtifact} = await artifactClient.getArtifact(
      inputs.name,
      options
    )

    if (!targetArtifact) {
      throw new Error(`Artifact '${inputs.name}' not found`)
    }

    core.debug(
      `Found named artifact '${inputs.name}' (ID: ${targetArtifact.id}, Size: ${targetArtifact.size})`
    )

    artifacts = [targetArtifact]
  } else if (isDownloadByIds) {
    core.info(`Downloading artifacts by ID`)

    const artifactIdList = inputs.artifactIds
      .split(',')
      .map(id => id.trim())
      .filter(id => id !== '')

    if (artifactIdList.length === 0) {
      throw new Error(`No valid artifact IDs provided in 'artifact-ids' input`)
    }

    core.debug(`Parsed artifact IDs: ${JSON.stringify(artifactIdList)}`)

    // Parse the artifact IDs
    artifactIds = artifactIdList.map(id => {
      const numericId = parseInt(id, 10)
      if (isNaN(numericId)) {
        throw new Error(`Invalid artifact ID: '${id}'. Must be a number.`)
      }
      return numericId
    })

    // We need to fetch all artifacts to get metadata for the specified IDs
    const listArtifactResponse = await artifactClient.listArtifacts({
      latest: true,
      ...options
    })

    manifestPaths = await readAllManifests(
      listArtifactResponse.artifacts,
      options,
      inputs.digestMismatch
    )
    artifacts = listArtifactResponse.artifacts.filter(artifact =>
      artifactIds.includes(artifact.id)
    )

    if (artifacts.length === 0) {
      throw new Error(`None of the provided artifact IDs were found`)
    }

    if (artifacts.length < artifactIds.length) {
      const foundIds = artifacts.map(a => a.id)
      const missingIds = artifactIds.filter(id => !foundIds.includes(id))
      core.warning(
        `Could not find the following artifact IDs: ${missingIds.join(', ')}`
      )
    }

    core.debug(`Found ${artifacts.length} artifacts by ID`)
  } else {
    const listArtifactResponse = await artifactClient.listArtifacts({
      latest: true,
      ...options
    })
    manifestPaths = await readAllManifests(
      listArtifactResponse.artifacts,
      options,
      inputs.digestMismatch
    )
    artifacts = listArtifactResponse.artifacts

    core.debug(`Found ${artifacts.length} artifacts in run`)

    if (inputs.pattern) {
      core.info(`Filtering artifacts by pattern '${inputs.pattern}'`)
      const matcher = new Minimatch(inputs.pattern)
      // A pattern may match either the artifact name or, for files uploaded by
      // upload-artifact with a manifest, the original relative path
      artifacts = artifacts.filter(artifact => {
        const original = manifestPaths.get(artifact.name)
        return (
          matcher.match(artifact.name) ||
          (original !== undefined && matcher.match(original))
        )
      })
      core.info(
        `Pattern '${inputs.pattern}' matched ${artifacts.length} of ${listArtifactResponse.artifacts.length} artifacts`
      )
      if (artifacts.length === 0) {
        core.warning(
          `Pattern '${inputs.pattern}' matched no artifact names or uploaded file paths. Available paths: ${[...manifestPaths.values()].slice(0, 20).join(', ') || '(none)'}`
        )
      }
    } else {
      core.info(
        'No input name, artifact-ids or pattern filtered specified, downloading all artifacts'
      )
      if (!inputs.mergeMultiple) {
        core.info(
          'An extra directory with the artifact name will be created for each download'
        )
      }
    }
  }

  // An upload-artifact manifest (archive: false with multiple files) lets us
  // restore the original directory structure of the files it describes
  artifacts = artifacts.filter(a => !isManifestName(a.name))
  const restorePaths = new Map<string, string>()
  for (const a of artifacts) {
    const original = manifestPaths.get(a.name)
    if (original !== undefined) {
      restorePaths.set(a.name, original)
    }
  }
  // Fail before downloading anything if a manifest path is unsafe
  restorePaths.forEach(original => resolveRestorePath(resolvedPath, original))
  if (restorePaths.size) {
    core.info(
      `Restoring original paths for ${restorePaths.size} artifact(s) using upload manifest(s)`
    )
  }
  const stagingDir = restorePaths.size
    ? await fs.mkdtemp(
        path.join(
          process.env['RUNNER_TEMP'] || os.tmpdir(),
          'download-staging-'
        )
      )
    : ''

  try {
    if (artifacts.length) {
      core.info(`Preparing to download the following artifacts:`)
      artifacts.forEach(artifact => {
        core.info(
          `- ${artifact.name} (ID: ${artifact.id}, Size: ${artifact.size}, Expected Digest: ${artifact.digest})`
        )
      })
    }

    const downloadPromises = artifacts.map(artifact => ({
      name: artifact.name,
      promise: artifactClient.downloadArtifact(artifact.id, {
        ...options,
        path: restorePaths.has(artifact.name)
          ? path.join(stagingDir, String(artifact.id))
          : isSingleArtifactDownload ||
              inputs.mergeMultiple ||
              artifacts.length === 1
            ? resolvedPath
            : path.join(resolvedPath, artifact.name),
        expectedHash: artifact.digest,
        skipDecompress: inputs.skipDecompress
      })
    }))

    const chunkedPromises = chunk(downloadPromises, PARALLEL_DOWNLOADS)
    const digestMismatches: string[] = []

    for (const chunk of chunkedPromises) {
      const chunkPromises = chunk.map(item => item.promise)
      const results = await Promise.all(chunkPromises)

      for (let i = 0; i < results.length; i++) {
        const outcome = results[i]
        const artifactName = chunk[i].name

        if (outcome.digestMismatch) {
          digestMismatches.push(artifactName)
          const message = `Artifact '${artifactName}' digest validation failed. Please verify the integrity of the artifact.`

          switch (inputs.digestMismatch) {
            case DigestMismatchBehavior.Ignore:
              // Do nothing
              break
            case DigestMismatchBehavior.Info:
              core.info(message)
              break
            case DigestMismatchBehavior.Warn:
              core.warning(message)
              break
            case DigestMismatchBehavior.Error:
              // Collect all errors and fail at the end
              break
          }
        }
      }
    }

    // If there were digest mismatches and behavior is 'error', fail the action
    if (
      digestMismatches.length > 0 &&
      inputs.digestMismatch === DigestMismatchBehavior.Error
    ) {
      throw new Error(
        `Digest validation failed for artifact(s): ${digestMismatches.join(', ')}. ` +
          `Use 'digest-mismatch: warn' to continue on mismatch.`
      )
    }

    if (stagingDir) {
      for (const artifact of artifacts) {
        const relative = restorePaths.get(artifact.name)
        if (relative === undefined) continue
        const dest = resolveRestorePath(resolvedPath, relative)
        const source = path.join(stagingDir, String(artifact.id))
        const files = await fs.readdir(source)
        if (files.length !== 1) {
          throw new Error(
            `Expected one file in artifact '${artifact.name}' but found ${files.length}`
          )
        }
        core.info(`Restoring '${artifact.name}' to '${dest}'`)
        await copyRestoredFile(resolvedPath, dest, path.join(source, files[0]))
      }
    }
  } finally {
    if (stagingDir) {
      await fs.rm(stagingDir, {recursive: true, force: true})
    }
  }

  core.info(`Total of ${artifacts.length} artifact(s) downloaded`)
  core.setOutput(Outputs.DownloadPath, resolvedPath)
  core.info('Download artifact has finished successfully')
}

run().catch(err =>
  core.setFailed(`Unable to download artifact(s): ${err.message}`)
)
