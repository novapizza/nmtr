const yaml = require('js-yaml')
const fs = require('fs')
const path = require('path')

const base = yaml.load(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'))

const {
  AZURE_PUBLISHER_NAME,
  AZURE_TRUSTED_SIGNING_ENDPOINT,
  AZURE_CODE_SIGNING_ACCOUNT_NAME,
  AZURE_CERT_PROFILE_NAME,
  R2_RELEASES_ACCOUNT_ID,
  R2_RELEASES_BUCKET,
  GH_TOKEN,
} = process.env

// koffi ships Rust-compiled pre-built binaries per-platform (not node-gyp).
// The base YAML was authored for Windows and strips darwin_*. On macOS we flip:
// keep darwin, strip win32 instead. The separate arm64/ia32 exclusions are
// subsumed by the wildcard win32_* added below.
if (process.platform === 'darwin') {
  base.files = base.files
    .map(f => {
      if (f === '!node_modules/koffi/build/koffi/darwin_*/**/*') {
        return '!node_modules/koffi/build/koffi/win32_*/**/*'
      }
      if (
        f === '!node_modules/koffi/build/koffi/win32_arm64/**/*' ||
        f === '!node_modules/koffi/build/koffi/win32_ia32/**/*'
      ) {
        return null // already covered by win32_* above
      }
      return f
    })
    .filter(Boolean)
}

const allAzureVarsSet = [
  AZURE_PUBLISHER_NAME,
  AZURE_TRUSTED_SIGNING_ENDPOINT,
  AZURE_CODE_SIGNING_ACCOUNT_NAME,
  AZURE_CERT_PROFILE_NAME,
].every(Boolean)

// koffi uses pre-built Rust binaries — no node-gyp binding.gyp present.
// Skip electron-rebuild entirely to avoid a false "no binding" failure.
const noRebuild = {
  nodeGypRebuild: false,
  npmRebuild: false,
}

// Build publish targets only when env vars are present — avoids URL parse
// errors when running locally without R2 / GH credentials.
const publish = []
if (R2_RELEASES_ACCOUNT_ID && R2_RELEASES_BUCKET) {
  // S3 publisher uploads artifacts to R2; publishAutoUpdate:false so it is
  // NOT embedded in app-update.yml (the S3 API endpoint requires auth).
  publish.push({
    provider: 's3',
    bucket: R2_RELEASES_BUCKET,
    region: 'auto',
    endpoint: `https://${R2_RELEASES_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    acl: null
  })
}
// if (GH_TOKEN) {
//   publish.push({ provider: 'github', releaseType: 'release' })
// }

const config = {
  ...base,
  ...noRebuild,
  ...(publish.length ? { publish } : {}),
}

module.exports = allAzureVarsSet
  ? {
      ...config,
      win: {
        ...base.win,
        azureSignOptions: {
          publisherName: AZURE_PUBLISHER_NAME,
          endpoint: AZURE_TRUSTED_SIGNING_ENDPOINT,
          codeSigningAccountName: AZURE_CODE_SIGNING_ACCOUNT_NAME,
          certificateProfileName: AZURE_CERT_PROFILE_NAME,
        },
      },
    }
  : config
