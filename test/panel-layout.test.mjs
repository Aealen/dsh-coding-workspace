import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PUSH_MIN_VIEWPORT,
  clampPanelWidth,
  parseStoredWidth,
} from '../lib/panel-layout.js'

test('clampPanelWidth: 正常值原样保留', () => {
  assert.equal(clampPanelWidth(360), 360)
  assert.equal(clampPanelWidth(400), 400)
})

test('clampPanelWidth: 越界夹到 [MIN, MAX]', () => {
  assert.equal(clampPanelWidth(100), MIN_PANEL_WIDTH)
  assert.equal(clampPanelWidth(9999), MAX_PANEL_WIDTH)
})

test('clampPanelWidth: 视口过窄时上限让位于视口(两侧留 16px)', () => {
  // 500 宽视口:上限 500-32=468 > MIN,夹到 468
  assert.equal(clampPanelWidth(520, 500), 468)
  // 极窄视口:上限低于 MIN 时取 MIN(面板仍可用)
  assert.equal(clampPanelWidth(360, 200), MIN_PANEL_WIDTH)
})

test('clampPanelWidth: 非法输入回落默认宽(受视口上限约束)', () => {
  assert.equal(clampPanelWidth(Number.NaN), DEFAULT_PANEL_WIDTH)
  assert.equal(clampPanelWidth(undefined), DEFAULT_PANEL_WIDTH)
  // 视口 300:上限 max(300-32, MIN)=280,回落值同样被夹到 280
  assert.equal(clampPanelWidth(Number.NaN, 300), MIN_PANEL_WIDTH)
})

test('clampPanelWidth: 小数四舍五入为整数像素', () => {
  assert.equal(clampPanelWidth(360.6), 361)
})

test('parseStoredWidth: 合法正数解析,其余 null', () => {
  assert.equal(parseStoredWidth('420'), 420)
  assert.equal(parseStoredWidth(' 360 '), 360)
  assert.equal(parseStoredWidth('0'), null)
  assert.equal(parseStoredWidth('-5'), null)
  assert.equal(parseStoredWidth('abc'), null)
  assert.equal(parseStoredWidth(''), null)
  assert.equal(parseStoredWidth('Infinity'), null)
})

test('PUSH_MIN_VIEWPORT: 推挤最小视口阈值合理(窄屏退浮层)', () => {
  assert.equal(typeof PUSH_MIN_VIEWPORT, 'number')
  assert.ok(PUSH_MIN_VIEWPORT >= 600 && PUSH_MIN_VIEWPORT <= 1024)
})
