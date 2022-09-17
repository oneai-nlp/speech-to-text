const path = require("path");

module.exports = {
  entry: "./src/web_voice.js",
  output: {
    path: path.resolve(__dirname, "docs"),
    filename: "soniox-web-voice.js",
    library: "sonioxWebVoice",
    libraryTarget: "var",
  },
};
