export const BUILD_OPTIONS = {
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  preserveSymlinks: true,
};
