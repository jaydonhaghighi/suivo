const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Watchman is broken on this machine (missing ICU dylib), which causes Metro
// bundle requests to hang and eventually timeout in Expo Go. Metro reads this
// from `resolver.useWatchman` (not `watcher.useWatchman`).
config.resolver = {
  ...(config.resolver ?? {}),
  useWatchman: false
};

module.exports = config;
