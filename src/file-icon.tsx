/**
 * 文件类型图标(扩展名色块徽标):panel 文件树与 topbar 文件 TAB 共用。
 * 命中 FILE_BADGES 出色块+缩写字徽标,未命中出通用文件轮廓。
 * (2026-09-04 自 panel.tsx 抽出——topbar 引入时避免整文件依赖。)
 */
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

const FILE_BADGES: Array<[string, string, string]> = [
  ['ts', '#3178c6', 'TS'], ['tsx', '#3178c6', 'TS'], ['mts', '#3178c6', 'TS'], ['cts', '#3178c6', 'TS'],
  ['js', '#b8860b', 'JS'], ['jsx', '#b8860b', 'JS'], ['mjs', '#b8860b', 'JS'], ['cjs', '#b8860b', 'JS'],
  ['json', '#8f8a00', '{}'], ['jsonc', '#8f8a00', '{}'],
  ['md', '#519aba', 'MD'], ['mdx', '#519aba', 'MD'],
  ['py', '#3572A5', 'PY'],
  ['html', '#e34c26', '<>'], ['htm', '#e34c26', '<>'],
  ['css', '#563d7c', 'CS'], ['scss', '#c6538c', 'SC'], ['sass', '#c6538c', 'SC'], ['less', '#2b5e8f', 'LE'],
  ['yml', '#a8552d', 'Y'], ['yaml', '#a8552d', 'Y'], ['toml', '#8a7a52', 'T'],
  ['sh', '#4a7a2a', '$_'], ['bash', '#4a7a2a', '$_'], ['zsh', '#4a7a2a', '$_'],
  ['ps1', '#5391EC', 'PS'], ['bat', '#777d1a', 'BT'], ['cmd', '#777d1a', 'BT'],
  ['go', '#00879c', 'GO'], ['rs', '#b0653a', 'RS'], ['java', '#b07219', 'JV'],
  ['c', '#555555', 'C'], ['h', '#555555', 'C'], ['cpp', '#00599c', 'C+'], ['cc', '#00599c', 'C+'], ['hpp', '#00599c', 'C+'],
  ['cs', '#178600', 'C#'], ['rb', '#701516', 'RB'], ['php', '#4F5D95', 'PP'],
  ['swift', '#e0623d', 'SW'], ['kt', '#7F52FF', 'KT'], ['scala', '#a32222', 'SC'],
  ['vue', '#3f9e76', 'V'], ['svelte', '#c4532f', 'SV'],
  ['sql', '#b56a2b', 'SQ'], ['xml', '#0060ac', 'XM'],
  ['png', '#8250df', 'IM'], ['jpg', '#8250df', 'IM'], ['jpeg', '#8250df', 'IM'], ['gif', '#8250df', 'IM'],
  ['bmp', '#8250df', 'IM'], ['webp', '#8250df', 'IM'], ['svg', '#8250df', 'SV'], ['ico', '#8250df', 'IM'],
  ['zip', '#9a6700', 'AR'], ['rar', '#9a6700', 'AR'], ['7z', '#9a6700', 'AR'], ['tar', '#9a6700', 'AR'],
  ['gz', '#9a6700', 'AR'], ['bz2', '#9a6700', 'AR'], ['xz', '#9a6700', 'AR'],
  ['pdf', '#cc2418', 'PD'],
  ['doc', '#2b579a', 'DO'], ['docx', '#2b579a', 'DO'],
  ['xls', '#217346', 'XL'], ['xlsx', '#217346', 'XL'], ['csv', '#217346', 'C,'],
  ['ppt', '#c04325', 'PT'], ['pptx', '#c04325', 'PT'],
  ['txt', '#6e7781', 'TX'], ['log', '#6e7781', 'TX'], ['ini', '#6e7781', 'CF'], ['cfg', '#6e7781', 'CF'],
  ['conf', '#6e7781', 'CF'], ['env', '#6e7781', 'CF'], ['lock', '#6e7781', 'LO'],
  ['gitignore', '#6e7781', 'GI'], ['dockerignore', '#6e7781', 'GI'], ['editorconfig', '#6e7781', 'EC'],
  ['dockerfile', '#2496ed', 'DK'], ['makefile', '#6e7781', 'MK'], ['license', '#6e7781', 'LI'],
]

/** 通用文件轮廓(未命中徽标表时的兜底,同族线性风格)。 */
function GenericFileGlyph(props: { size?: number }) {
  return jsx('svg', {
    width: props.size ?? 13,
    height: props.size ?? 13,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { flexShrink: 0 },
    children: jsx('path', { d: 'M8 1.5H3.5A1 1 0 0 0 2.5 2.5v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5zM8 1.5V5h3.5' }),
  })
}

function FileIcon(props: { name: string }): any {
  const ext = (props.name.includes('.') ? props.name.split('.').pop()! : props.name).toLowerCase()
  const hit = FILE_BADGES.find(([e]) => e === ext)
  if (hit === undefined) {
    // 无命中:通用文件轮廓(灰)
    return jsx('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-dimmed)' }, children: jsx(GenericFileGlyph, { size: 13 }) })
  }
  const [, color, label] = hit
  return jsx('svg', {
    width: 14,
    height: 13,
    viewBox: '0 0 16 15',
    style: { flexShrink: 0 },
    children: jsxs(Fragment, {
      children: [
        jsx('rect', { x: '1', y: '1.5', width: '14', height: '12', rx: '3', fill: color }),
        jsx('text', {
          x: '8',
          y: label.length === 1 ? '10.4' : '10',
          textAnchor: 'middle',
          fontSize: label.length === 1 ? 8.5 : 7.2,
          fontWeight: 700,
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fill: '#ffffff',
          children: label,
        }),
      ],
    }),
  })
}

export { FileIcon }
