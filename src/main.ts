import { Chart, registerables } from 'chart.js'
import { unzipSync } from 'fflate'
import './style.css'

Chart.register(...registerables)

type HourlyReading = { timestamp: string; year: number; temperature: number }
type PumpRow = { outdoorTemperature: number; minimum: number; maximum: number }
type SeriesPoint = { temperature: number; hours: number }
type CachedSeries = { all: SeriesPoint[]; last10: SeriesPoint[]; last5: SeriesPoint[] }

const DWD_ROOT = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/air_temperature'
const CACHE_PREFIX = 'heizlast:dwd:'
const DEFAULT_STATION = '03485'
const DEFAULT_PUMPS: PumpRow[] = [
	{ outdoorTemperature: -15, minimum: 5, maximum: 14 },
	{ outdoorTemperature: -10, minimum: 5, maximum: 14 },
	{ outdoorTemperature: -5, minimum: 4, maximum: 14 },
	{ outdoorTemperature: 0, minimum: 4, maximum: 14 },
	{ outdoorTemperature: 5, minimum: 3, maximum: 13 },
	{ outdoorTemperature: 10, minimum: 3, maximum: 11 },
	{ outdoorTemperature: 15, minimum: 3, maximum: 9 },
]

let chart: Chart<'line'> | undefined
let readings: HourlyReading[] = []

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
	<main class="shell">
		<header class="masthead"><p class="eyebrow">Heizlastanalyse</p><h1>Wetterprofil für die Wärmepumpe</h1><p class="intro">Stündliche DWD-Temperaturen werden zu einer Jahresverteilung verdichtet.</p></header>
		<section class="controls" aria-label="Eingaben"><div class="section-heading"><span>01</span><h2>Berechnungsgrundlage</h2></div><div class="input-grid"><label>Heizlast <span class="unit">kW</span><input id="heating-load" type="number" value="14" min="0" step="0.1"></label><label>Normaußentemperatur <span class="unit">°C</span><input id="design-temperature" type="number" value="-13.1" step="0.1"></label></div></section>
		<section class="controls"><div class="section-heading"><span>02</span><h2>Wärmepumpenleistungsdaten</h2></div><div class="pump-table-wrap"><table><thead><tr><th>Außentemperatur (°C)</th><th>Min. Leistung (kW)</th><th>Max. Leistung (kW)</th><th><span class="sr-only">Aktion</span></th></tr></thead><tbody id="pump-rows"></tbody></table></div><button class="text-button" id="add-pump" type="button">+ Zeile hinzufügen</button></section>
		<section class="controls station-section"><div class="section-heading"><span>03</span><h2>Klimadaten</h2></div><div class="station-form"><label>DWD-Station <input id="station-id" value="${DEFAULT_STATION}" inputmode="numeric" maxlength="5" pattern="[0-9]{5}"></label></div><div class="dwd-links"><a id="history-link" href="${DWD_ROOT}/historical/" target="_blank" rel="noreferrer">Historische DWD-Daten öffnen ↗</a><a id="current-link" href="${DWD_ROOT}/recent/stundenwerte_TU_${DEFAULT_STATION}_akt.zip" target="_blank" rel="noreferrer">Aktuelle Stationsdatei öffnen ↗</a></div><div class="file-grid"><label>Historische ZIP-Datei <input id="historical-file" type="file" accept=".zip,application/zip"></label><label>Aktuelle ZIP-Datei <input id="recent-file" type="file" accept=".zip,application/zip"></label></div><div class="station-form"><button class="primary-button" id="load-data" type="button">Dateien verarbeiten</button><button class="secondary-button" id="load-cache" type="button">Gespeicherte Daten laden</button><button class="secondary-button" id="clear-cache" type="button">Gespeicherten Cache löschen</button></div><p class="status" id="status" role="status">Bitte beide DWD-ZIP-Dateien auswählen oder gespeicherte Daten laden.</p></section>
		<section class="chart-section"><div class="section-heading"><span>04</span><div><h2>Temperaturhäufigkeit</h2><p>Durchschnittliche Stunden pro Jahr</p></div></div><div class="chart-frame"><canvas id="temperature-chart" aria-label="Durchschnittliche Stunden pro Jahr nach Temperatur"></canvas><div class="empty-state" id="empty-state">Lade eine DWD-Station, um das Profil zu sehen.</div></div><p class="chart-note">Die Zeiträume werden anhand der verfügbaren Kalenderjahre gebildet. Aktuelle und historische Daten mit gleichem Zeitstempel werden nur einmal gezählt.</p></section>
	</main>
`

function getInput(id: string): HTMLInputElement { return document.querySelector<HTMLInputElement>(`#${id}`)! }

function renderPumpRows(rows: PumpRow[]): void {
	document.querySelector<HTMLTableSectionElement>('#pump-rows')!.innerHTML = rows.map((row, index) => `<tr><td><input data-pump="outdoorTemperature" data-index="${index}" type="number" value="${row.outdoorTemperature}" step="0.1" aria-label="Außentemperatur"></td><td><input data-pump="minimum" data-index="${index}" type="number" value="${row.minimum}" min="0" step="0.1" aria-label="Minimale Leistung"></td><td><input data-pump="maximum" data-index="${index}" type="number" value="${row.maximum}" min="0" step="0.1" aria-label="Maximale Leistung"></td><td><button class="remove-row" data-remove="${index}" type="button" aria-label="Zeile ${index + 1} entfernen">×</button></td></tr>`).join('')
}

function readPumpRows(): PumpRow[] { return [...document.querySelectorAll<HTMLInputElement>('[data-pump="outdoorTemperature"]')].map((input) => { const index = Number(input.dataset.index); const field = (name: keyof PumpRow) => Number(document.querySelector<HTMLInputElement>(`[data-pump="${name}"][data-index="${index}"]`)!.value); return { outdoorTemperature: field('outdoorTemperature'), minimum: field('minimum'), maximum: field('maximum') } }) }
function cacheKey(station: string): string { return `${CACHE_PREFIX}${station}` }
async function getCsv(file: File): Promise<string> { const archive = unzipSync(new Uint8Array(await file.arrayBuffer())); const entry = Object.entries(archive).find(([name]) => name.includes('produkt_tu_stunde')); if (!entry) throw new Error(`Keine produkt_tu_stunde-Datei in ${file.name} gefunden.`); return new TextDecoder('utf-8').decode(entry[1]) }

function parseCsv(csv: string): HourlyReading[] { const rows: HourlyReading[] = []; for (const line of csv.split(/\r?\n/).slice(1)) { const columns = line.split(';'); const rawDate = columns[1]?.trim(); const temperature = Number(columns[3]?.trim().replace(',', '.')); if (!/^\d{10}$/.test(rawDate ?? '') || !Number.isFinite(temperature) || temperature <= -999) continue; rows.push({ timestamp: rawDate, year: Number(rawDate.slice(0, 4)), temperature: Math.round(temperature * 10) / 10 }) } return rows }

function calculateSeries(periodYears?: number): { temperature: number; hours: number }[] { if (!readings.length) return []; const newestYear = Math.max(...readings.map((reading) => reading.year)); const selected = periodYears ? readings.filter((reading) => reading.year >= newestYear - periodYears + 1) : readings; const years = new Set(selected.map((reading) => reading.year)).size || 1; const counts = new Map<number, number>(); selected.forEach((reading) => counts.set(reading.temperature, (counts.get(reading.temperature) ?? 0) + 1)); return [...counts.entries()].sort(([a], [b]) => a - b).map(([temperature, count]) => ({ temperature, hours: count / years })) }

function updateChart(series: CachedSeries): void {
	const labels = [...new Set([series.all, series.last10, series.last5].flatMap((points) => points.map((point) => point.temperature)))].sort((a, b) => a - b)
	const colors = ['#183f3a', '#d47749', '#d2a63d']
	const datasets = [{ label: 'Gesamter Zeitraum', points: series.all }, { label: 'Letzte 10 Jahre', points: series.last10 }, { label: 'Letzte 5 Jahre', points: series.last5 }].map((item, index) => { const values = new Map(item.points.map((point) => [point.temperature, point.hours])); return { label: item.label, data: labels.map((temperature) => values.get(temperature) ?? null), borderColor: colors[index], backgroundColor: colors[index], borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: false } })
	chart?.destroy(); chart = new Chart(document.querySelector<HTMLCanvasElement>('#temperature-chart')!, { type: 'line', data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, padding: 24 } }, tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(1)} h/Jahr` } } }, scales: { x: { title: { display: true, text: 'Außentemperatur (°C)' }, grid: { color: '#e5e8df' } }, y: { beginAtZero: true, title: { display: true, text: 'Stunden pro Jahr' }, grid: { color: '#e5e8df' } } } } }); document.querySelector<HTMLDivElement>('#empty-state')!.hidden = series.all.length > 0
}

async function loadStation(): Promise<void> { const station = getInput('station-id').value.trim(); const historicalFile = document.querySelector<HTMLInputElement>('#historical-file')!.files?.[0]; const recentFile = document.querySelector<HTMLInputElement>('#recent-file')!.files?.[0]; if (!/^\d{5}$/.test(station)) throw new Error('Bitte eine fünfstellige DWD-Stations-ID eingeben.'); if (!historicalFile || !recentFile) throw new Error('Bitte beide DWD-ZIP-Dateien auswählen.'); const status = document.querySelector<HTMLParagraphElement>('#status')!; const loadButton = document.querySelector<HTMLButtonElement>('#load-data')!; loadButton.disabled = true; status.textContent = 'Verarbeite die beiden ZIP-Dateien lokal …'; try { const [historicalCsv, recentCsv] = await Promise.all([getCsv(historicalFile), getCsv(recentFile)]); const unique = new Map<string, HourlyReading>(); for (const reading of [...parseCsv(historicalCsv), ...parseCsv(recentCsv)]) unique.set(reading.timestamp, reading); readings = [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)); const series: CachedSeries = { all: calculateSeries(), last10: calculateSeries(10), last5: calculateSeries(5) }; localStorage.removeItem(cacheKey(station)); localStorage.setItem(cacheKey(station), JSON.stringify(series)); status.textContent = `${readings.length.toLocaleString('de-DE')} Stunden verarbeitet und das Diagramm lokal gespeichert.`; updateChart(series) } finally { loadButton.disabled = false } }

function loadCachedData(): void { const station = getInput('station-id').value.trim(); if (!/^\d{5}$/.test(station)) throw new Error('Bitte eine fünfstellige DWD-Stations-ID eingeben.'); const cached = localStorage.getItem(cacheKey(station)); if (!cached) throw new Error(`Keine gespeicherten Daten für Station ${station} gefunden.`); const series = JSON.parse(cached) as CachedSeries; updateChart(series); document.querySelector('#status')!.textContent = 'Gespeicherte Diagrammdaten geladen.' }

renderPumpRows(DEFAULT_PUMPS)
document.querySelector<HTMLButtonElement>('#add-pump')!.addEventListener('click', () => renderPumpRows([...readPumpRows(), { outdoorTemperature: 0, minimum: 0, maximum: 0 }]))
document.querySelector<HTMLTableSectionElement>('#pump-rows')!.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]'); if (button) renderPumpRows(readPumpRows().filter((_, index) => index !== Number(button.dataset.remove))) })
document.querySelector<HTMLInputElement>('#station-id')!.addEventListener('input', (event) => { const station = (event.target as HTMLInputElement).value.trim(); document.querySelector<HTMLAnchorElement>('#current-link')!.href = `${DWD_ROOT}/recent/stundenwerte_TU_${station}_akt.zip` })
document.querySelector<HTMLButtonElement>('#load-data')!.addEventListener('click', () => void loadStation().catch((error: Error) => { document.querySelector('#status')!.textContent = error.message }))
document.querySelector<HTMLButtonElement>('#load-cache')!.addEventListener('click', () => { try { loadCachedData() } catch (error) { document.querySelector('#status')!.textContent = (error as Error).message } })
document.querySelector<HTMLButtonElement>('#clear-cache')!.addEventListener('click', () => { const station = getInput('station-id').value.trim(); localStorage.removeItem(cacheKey(station)); document.querySelector('#status')!.textContent = 'Gespeicherter Cache gelöscht.' })
