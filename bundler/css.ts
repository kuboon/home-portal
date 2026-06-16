/**
 * Tailwind CSS build via `@kuboon/tailwindcss-deno`.
 *
 * Compiles `assets/style.css` (which `@import`s `tailwindcss/index.css`)
 * into `server/bundled/style.css`, scanning the `server` and `client` trees
 * for class candidates.
 */

import { compile, optimize } from "@kuboon/tailwindcss-deno";
import { Scanner } from "@tailwindcss/oxide";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
// `@plugin "daisyui"` / bare imports in the CSS are resolved by the loader
// relative to `base`; point it at this bundler dir whose deno.json carries
// the `daisyui` + `tailwindcss` import map entries.
const BUNDLER_DIR = new URL(".", import.meta.url).pathname;
const INPUT = new URL("../assets/style.css", import.meta.url).pathname;
const OUTPUT = new URL("../server/bundled/style.css", import.meta.url).pathname;

export async function buildCss(
  { minify = false }: { minify?: boolean } = {},
) {
  const scanner = new Scanner({
    sources: [
      { base: `${REPO_ROOT}server`, pattern: "**/*", negated: false },
      { base: `${REPO_ROOT}client`, pattern: "**/*", negated: false },
    ],
  });
  const candidates = scanner.scan();

  const input = await Deno.readTextFile(INPUT);
  const compiler = await compile(input, {
    base: BUNDLER_DIR,
    from: INPUT,
    onDependency: () => {},
    customCssResolver: (id) => {
      // `tailwindcss/index.css` is not exposed via the package's
      // `exports`, so @deno/loader can't resolve it. Fall back to
      // import.meta.resolve which honors this bundler's import map.
      if (id === "tailwindcss/index.css") {
        const pathname = new URL(import.meta.resolve(id)).pathname;
        console.log(`[css] resolved ${id} to ${pathname}`);
        return Promise.resolve(pathname);
      }
      return Promise.resolve(undefined);
    },
  });

  const built = compiler.build(candidates);
  const { code } = optimize(built, { minify, file: OUTPUT });

  await Deno.mkdir(new URL("../server/bundled", import.meta.url), {
    recursive: true,
  });
  await Deno.writeTextFile(OUTPUT, code);
  return { output: OUTPUT, bytes: code.length };
}
