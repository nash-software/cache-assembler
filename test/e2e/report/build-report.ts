import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { TelemetryStore } from '../../../src/telemetry.js'

// Structural copies of the interfaces in test/e2e/synthetic/run-synthetic.ts
// (LayerResult / ConcurrencyResult / SyntheticOutput, lines 31-55). They are
// intentionally NOT imported from there: that module is not exported and
// calls main() unguarded at top level, so importing it would execute an
// entire synthetic harness run as a side effect of loading this module.
export interface LayerResult {
  label: string
  cacheHitRate: number
  estSavedUsd: number
  requests: number
  cacheReads: number
  cacheWrites: number
  cacheReadTokens: number
  cacheCreationTokens: number
  failures: number
}

export interface ConcurrencyResult {
  instances: number
  barrierOnWrites: number
  barrierOffWrites: number
}

export interface HarnessOutput {
  generatedAt: string
  instances: number
  turns: number
  layers: Record<string, LayerResult>
  concurrency: ConcurrencyResult
}

export interface ReportInput {
  synthetic?: HarnessOutput
  real?: HarnessOutput
}

const LAYER_IDS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const

const CHART_BAR_WIDTH = 50
const CHART_BAR_GAP = 24
const CHART_PLOT_HEIGHT = 140
const CHART_TOP_MARGIN = 20
const CHART_BOTTOM_MARGIN = 40
const CHART_LEFT_MARGIN = 20
const CHART_BAR_FILL = '#4a7fd6'
const VALUE_LABEL_OFFSET_ABOVE = 4
const VALUE_LABEL_OFFSET_BELOW = 12
const LABEL_ROW_OFFSET = 16

/** Escapes the small set of characters that matter inside HTML text/attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Recomputes modeled $ saved from aggregate token totals by feeding a single
 * synthetic usage record into a fresh TelemetryStore — reusing
 * src/telemetry.ts's pricing formula exactly rather than re-deriving it here.
 * The formula is linear in cacheReadTokens/cacheCreationTokens, so one
 * aggregate record yields the same estSavedUsd as summing per-request.
 */
export function computeEstSavedUsd(cacheReadTokens: number, cacheCreationTokens: number): number {
  const store = new TelemetryStore()
  store.record({
    prefixHash: 'aggregate',
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
    },
  })
  return store.stats().estSavedUsd
}

/** Same rule as run-synthetic.ts's own cache-hit-rate calculation: reads / requests, 0 when no requests. */
export function computeCacheHitRate(layer: LayerResult): number {
  return layer.requests === 0 ? 0 : layer.cacheReads / layer.requests
}

/**
 * Hand-rolled inline SVG bar chart — no charting dependency. Domain is
 * [min(0, ...values), max(0, ...values)] with a drawn zero-baseline so
 * negative values (e.g. L2's modeled $ saved) render as bars below the line.
 * An all-zero domain falls back to a range of 1 to avoid division by zero,
 * producing flat bars at the baseline instead of NaN.
 */
export function renderBarChart(
  rows: ReadonlyArray<{ label: string; value: number }>,
  opts: { title: string; format: (value: number) => string },
): string {
  const svgHeight = CHART_TOP_MARGIN + CHART_PLOT_HEIGHT + CHART_BOTTOM_MARGIN
  const svgWidth = CHART_LEFT_MARGIN * 2 + rows.length * (CHART_BAR_WIDTH + CHART_BAR_GAP)

  const values = rows.map((row) => row.value)
  const domainMin = Math.min(0, ...values)
  const domainMax = Math.max(0, ...values)
  const range = domainMax - domainMin || 1

  const yFor = (value: number): number =>
    CHART_TOP_MARGIN + CHART_PLOT_HEIGHT - ((value - domainMin) / range) * CHART_PLOT_HEIGHT
  const baselineY = yFor(0)

  const bars = rows
    .map((row, index) => {
      const x = CHART_LEFT_MARGIN + index * (CHART_BAR_WIDTH + CHART_BAR_GAP)
      const barY = Math.min(yFor(row.value), baselineY)
      const barHeight = Math.abs(yFor(row.value) - baselineY)
      const labelY = svgHeight - CHART_BOTTOM_MARGIN + LABEL_ROW_OFFSET
      const valueY = row.value >= 0 ? barY - VALUE_LABEL_OFFSET_ABOVE : barY + barHeight + VALUE_LABEL_OFFSET_BELOW
      const barCenterX = x + CHART_BAR_WIDTH / 2
      return [
        `<rect x="${x}" y="${barY}" width="${CHART_BAR_WIDTH}" height="${barHeight}" fill="${CHART_BAR_FILL}" />`,
        `<text class="bar-label" x="${barCenterX}" y="${labelY}" text-anchor="middle">${escapeHtml(row.label)}</text>`,
        `<text class="bar-value" x="${barCenterX}" y="${valueY}" text-anchor="middle">${escapeHtml(opts.format(row.value))}</text>`,
      ].join('\n')
    })
    .join('\n')

  return [
    '<div class="chart-wrap">',
    `<svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">`,
    `<title>${escapeHtml(opts.title)}</title>`,
    `<line x1="0" y1="${baselineY}" x2="${svgWidth}" y2="${baselineY}" stroke="#999" stroke-width="1" />`,
    bars,
    '</svg>',
    '</div>',
  ].join('\n')
}

function layerIdsPresentIn(layers: Record<string, LayerResult>): (typeof LAYER_IDS)[number][] {
  return LAYER_IDS.filter((id) => id in layers)
}

/** Looks up a layer already confirmed present by layerIdsPresentIn — throws instead of silently rendering undefined. */
function getLayer(layers: Record<string, LayerResult>, id: string): LayerResult {
  const layer = layers[id]
  if (!layer) throw new Error(`expected layer '${id}' to be present`)
  return layer
}

function renderConcurrencyVerdict(concurrency: ConcurrencyResult): string {
  if (concurrency.barrierOnWrites < concurrency.barrierOffWrites) {
    return `barrier collapsed ${concurrency.barrierOffWrites} concurrent identical-prefix writes to ${concurrency.barrierOnWrites}`
  }
  return `barrier did not reduce concurrent identical-prefix writes (barrier-on: ${concurrency.barrierOnWrites}, barrier-off: ${concurrency.barrierOffWrites})`
}

function renderRawNumbersTable(layerIds: ReadonlyArray<string>, layers: Record<string, LayerResult>): string {
  const rows = layerIds
    .map((id) => {
      const layer = getLayer(layers, id)
      const saved = computeEstSavedUsd(layer.cacheReadTokens, layer.cacheCreationTokens)
      return `<tr><td>${escapeHtml(id)} — ${escapeHtml(layer.label)}</td><td>${layer.requests}</td><td>${layer.cacheReads}</td><td>${layer.cacheWrites}</td><td>${layer.cacheReadTokens}</td><td>${layer.cacheCreationTokens}</td><td>$${saved.toFixed(6)}</td><td>${layer.failures}</td></tr>`
    })
    .join('\n')

  return [
    '<table>',
    '<thead><tr><th>Layer</th><th>Requests</th><th>Cache reads</th><th>Cache writes</th><th>Cache read tokens</th><th>Cache creation tokens</th><th>Est. $ saved</th><th>Failures</th></tr></thead>',
    `<tbody>\n${rows}\n</tbody>`,
    '</table>',
  ].join('\n')
}

/** Renders the four required sections (cache-hit-rate chart, $-saved chart, raw table, concurrency proof) for one harness run. */
function renderHarnessSection(title: string, data: HarnessOutput): string {
  const layerIds = layerIdsPresentIn(data.layers)

  const cacheHitRows = layerIds.map((id) => ({ label: id, value: computeCacheHitRate(getLayer(data.layers, id)) }))
  const savedRows = layerIds.map((id) => {
    const layer = getLayer(data.layers, id)
    return { label: id, value: computeEstSavedUsd(layer.cacheReadTokens, layer.cacheCreationTokens) }
  })

  const cacheHitChart = renderBarChart(cacheHitRows, {
    title: 'Cache-hit-rate by layer',
    format: (value) => `${(value * 100).toFixed(1)}%`,
  })
  const savedChart = renderBarChart(savedRows, {
    title: '$ saved by layer (modeled)',
    format: (value) => `$${value.toFixed(6)}`,
  })

  const concurrency = data.concurrency
  const verdict = renderConcurrencyVerdict(concurrency)

  return [
    '<div class="harness-block">',
    `<h3>${escapeHtml(title)}</h3>`,
    '<h2>Cache-hit-rate by layer</h2>',
    cacheHitChart,
    '<h2>$ saved by layer (modeled)</h2>',
    savedChart,
    '<h3>Raw numbers</h3>',
    renderRawNumbersTable(layerIds, data.layers),
    '<h2>Concurrency proof</h2>',
    `<p>Instances: ${concurrency.instances}. Barrier-on writes: ${concurrency.barrierOnWrites}. Barrier-off writes: ${concurrency.barrierOffWrites}.</p>`,
    `<p>${escapeHtml(verdict)}</p>`,
    '</div>',
  ].join('\n')
}

const REAL_ABSENT_NOTE =
  'Real-CLI results not present — run npm run e2e:real -- --confirm to add them.'

/**
 * Merges synthetic + real harness output into one self-contained HTML report
 * string. Real-CLI numbers headline first when present; synthetic numbers
 * follow, labelled with their N. Throws if neither input is present.
 */
export function buildReportHtml(input: ReportInput): string {
  if (!input.synthetic && !input.real) {
    throw new Error('buildReportHtml requires at least one of synthetic or real result data')
  }

  const sections: string[] = []

  if (input.real) {
    sections.push(renderHarnessSection('Real-CLI results', input.real))
  } else {
    sections.push(`<p class="note">${escapeHtml(REAL_ABSENT_NOTE)}</p>`)
  }

  if (input.synthetic) {
    const title = `Synthetic (N=${input.synthetic.instances} instances × ${input.synthetic.turns} turns)`
    sections.push(renderHarnessSection(title, input.synthetic))
  }

  const templateUrl = new URL('./template.html', import.meta.url)
  const template = readFileSync(templateUrl, 'utf8')
  return template.replace('<!--REPORT_BODY-->', sections.join('\n'))
}

/** Reads and parses a result JSON file; returns undefined when the file is absent, throws on any other error (including malformed JSON). */
function readHarnessOutputIfPresent(path: URL): HarnessOutput | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HarnessOutput
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
}

async function main(): Promise<void> {
  const resultsDir = new URL('../results/', import.meta.url)
  const synthetic = readHarnessOutputIfPresent(new URL('synthetic.json', resultsDir))
  const real = readHarnessOutputIfPresent(new URL('real-cli.json', resultsDir))

  if (!synthetic && !real) {
    console.log('no result files found — run npm run e2e:synthetic first')
    process.exitCode = 1
    return
  }

  const html = buildReportHtml({ synthetic, real })
  await mkdir(resultsDir, { recursive: true })
  const reportPath = new URL('report.html', resultsDir)
  await writeFile(reportPath, html, 'utf8')
  console.log(`report written to ${reportPath.pathname}`)
}

// Guarded CLI entry: runs only when this file is the process's actual entry
// point (tsx CLI invocation), not when it's merely imported (e.g. by vitest
// for the pure exports above). Live-verified this session under tsx.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
