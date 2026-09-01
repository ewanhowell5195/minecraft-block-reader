import esbuild from "esbuild"
import fs from "node:fs"

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version

const banner = `/*!
 * minecraft-block-reader
 * Version  : ${version}
 * License  : MPL-2.0
 * Copyright: ${new Date().getFullYear()} Ewan Howell
 */`

await esbuild.build({
  entryPoints: ["src/index.js"],
  bundle: true,
  minify: true,
  format: "esm",
  banner: { js: banner },
  outfile: "dist/minecraft-block-reader.min.js"
})

fs.copyFileSync("wasm/minecraft_block_reader_bg.wasm", "dist/minecraft_block_reader_bg.wasm")

console.log("Built minecraft-block-reader v" + version)
