// 客户端半区构建:把 src/client.ts 打成 dsh client-modules 的工厂形态。
// 产物 lib/client.js = window.__ModuleLoader__.load({id, factory:(require,module,exports)=>{...}});
// id 必须等于包名(boot graph 的 entry name == package name)。
import { build } from 'esbuild'

const pkg = 'dsh-worktree'

await build({
  entryPoints: ['src/client.tsx'],
  bundle: true,
  format: 'cjs',
  target: 'es2023',
  outfile: 'lib/client.js',
  external: ['react', 'react/jsx-runtime'],
  banner: {
    // 宿主只传 require;module/exports 由 bundle 自造,尾部 return module.exports(对齐 ui-workspace 产物形态)
    js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg)},factory:(require)=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});`,
  },
  footer: {
    js: ';return module.exports;}});',
  },
})
