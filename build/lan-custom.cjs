function resolveComponents(pkg) {
  const components = pkg.components || {};
  return {
    scriptVersion: components.script || pkg.version,
    viewerVersion: components.viewer || pkg.version,
    gasVersion: components.gas || pkg.version,
  };
}

function resolveLanUserscriptMetadata(scriptVersion) {
  return {
    name: 'TokiSync (Link to Drive) [LAN Custom v1.22]',
    namespace: 'local://lan/tokisync-custom',
    version: scriptVersion,
    description: 'Toki series sites -> NAS/Drive syncing (Bundled) — LAN custom: 멀티-IP lease + 네이티브 NAS(WebDAV) on upstream v1.22.0',
    author: 'pray4skylark + local patch',
    updateURL: 'http://192.168.0.100:8765/docs/tokiSync.user.js',
    downloadURL: 'http://192.168.0.100:8765/docs/tokiSync.user.js',
  };
}

module.exports = {
  resolveComponents,
  resolveLanUserscriptMetadata,
};
