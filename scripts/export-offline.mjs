import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// A single HTML file for opening directly in a browser, without a server.
const root = new URL('../', import.meta.url);
const sources = [];
for (const name of ['generator', 'ai', 'export', 'app']) {
  let source = await readFile(new URL(`dist/${name}.mjs`, root), 'utf8');
  source = source.replace(/^import .+;\r?\n/gm, '').replace(/^export (?=(?:const|function)\b)/gm, '');
  if (/^\s*(?:import|export)\b/m.test(source)) throw new Error(`Unsupported module syntax in ${name}.mjs`);
  if (name === 'app') source = source.replace('mountApp(document,storage);', 'mountApp(document,storage,{offline:true});');
  sources.push(source);
}
const css = await readFile(new URL('dist/styles.css', root), 'utf8');
const code = `(() => {\n'use strict';\n${sources.join('\n')}\n})();`.replace(/<\/script/gi, '<\\/script');
const html = (await readFile(new URL('dist/index.html', root), 'utf8'))
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`)
  .replace(/^[ \t]*<script type="module" src="app\.mjs"><\/script>\r?\n/m, '')
  .replace('Курсовой проект</span>', 'Автономная версия</span>')
  .replace('</body>', `<script>\n${code}\n</script>\n</body>`);
const output = new URL('downloads/', root);
await mkdir(output, {recursive: true});
await writeFile(new URL('praktikum.html', output), html);
console.log(`Created ${fileURLToPath(new URL('praktikum.html', output))}`);
