import { niceStep } from './demultiplex-statistics.mjs';

const svgNamespace = 'http://www.w3.org/2000/svg';
const number = value => value.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
function element(name, attributes = {}, text) {
  const node = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function distributionChart(sample, kind) {
  const isLength = kind === 'length', bins = isLength ? sample.lengthHistogram : sample.qualityHistogram;
  const title = isLength ? 'リード長分布' : 'クオリティ分布';
  const axisLabel = isLength ? 'リード長 (bp)' : '元リードのヘッダーQスコア';
  const total = isLength ? sample.segments : sample.qualityReads;
  const svg = element('svg', { viewBox: '0 0 300 176', role: 'img', 'aria-label': `${sample.sample} の${title}：${number(total)} 配列`, class: `distribution-chart ${kind}-chart` });
  svg.append(element('title', {}, `${sample.sample} の${title}`), element('desc', {}, `${axisLabel}ごとの出力配列数。棒にカーソルを重ねると範囲と配列数を表示します。`));
  const left = 48, top = 22, width = 240, height = 112, bottom = top + height;
  let low = bins[0].lower, high = bins.at(-1).upper + (isLength ? 1 : 0);
  if (!isLength) { low = 0; high = Math.max(10, Math.ceil(high / 10) * 10); }
  else if (sample.minLength === sample.maxLength) {
    const margin = Math.max(5, sample.minLength * 0.05);
    low = Math.max(0, sample.minLength - margin); high = sample.maxLength + margin;
  }
  const xStep = niceStep((high - low) / 4);
  low = Math.floor(low / xStep) * xStep; high = Math.ceil(high / xStep) * xStep;
  const maxCount = Math.max(...bins.map(bin => bin.count)), yStep = niceStep(maxCount / 3), yMax = Math.ceil(maxCount / yStep) * yStep;
  const x = value => left + (value - low) / (high - low) * width;
  const y = value => bottom - value / yMax * height;
  svg.append(element('text', { x: left, y: 12, class: 'chart-axis-label' }, '出力配列数'));
  for (let tick = 0; tick <= yMax; tick += yStep) {
    svg.append(element('line', { x1: left, y1: y(tick), x2: left + width, y2: y(tick), class: 'chart-grid' }),
      element('text', { x: left - 6, y: y(tick) + 3, 'text-anchor': 'end', class: 'chart-tick' }, number(tick)));
  }
  for (const bin of bins) {
    if (!bin.count) continue;
    const binEnd = bin.upper + (isLength ? 1 : 0), barWidth = x(binEnd) - x(bin.lower);
    const bar = element('rect', { x: x(bin.lower), y: y(bin.count), width: Math.max(0.5, barWidth - Math.min(1, barWidth * 0.1)), height: bottom - y(bin.count), class: 'chart-bar', 'data-count': bin.count });
    const range = isLength ? (bin.lower === bin.upper ? `${number(bin.lower)} bp` : `${number(bin.lower)}–${number(bin.upper)} bp`) : `Q ${bin.lower} 以上 ${bin.upper} 未満`;
    bar.append(element('title', {}, `${range}：${number(bin.count)} 配列 (${number(bin.count / total * 100)}%)`));
    svg.append(bar);
  }
  for (let tick = low; tick <= high; tick += xStep) {
    svg.append(element('line', { x1: x(tick), y1: bottom, x2: x(tick), y2: bottom + 4, class: 'chart-axis' }),
      element('text', { x: x(tick), y: bottom + 17, 'text-anchor': tick === low ? 'start' : tick === high ? 'end' : 'middle', class: 'chart-tick' }, number(tick)));
  }
  svg.append(element('line', { x1: left, y1: bottom, x2: left + width, y2: bottom, class: 'chart-axis' }),
    element('text', { x: left + width / 2, y: 169, 'text-anchor': 'middle', class: 'chart-axis-label' }, axisLabel));
  return svg;
}
