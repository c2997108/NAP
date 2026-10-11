const names = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => names.compare(a.sample, b.sample) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const hasMean = file => Number.isFinite(file.meanLength);

export function selectFastqFiles(files, { sample = '', minReads = 0, minMeanLength = null, maxMeanLength = null, sort = 'sample-asc' } = {}) {
  if (!Number.isSafeInteger(minReads) || minReads < 0) throw Error('最低リード数には0以上の整数を入力してください。');
  for (const value of [minMeanLength, maxMeanLength]) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw Error('平均リード長には0以上の数値を入力してください。');
  }
  if (minMeanLength !== null && maxMeanLength !== null && minMeanLength > maxMeanLength) throw Error('平均リード長の上限は下限以上にしてください。');
  const term = sample.trim().toLowerCase();
  const result = files.filter(file => file.sample.toLowerCase().includes(term) && file.reads >= minReads
    && (minMeanLength === null || hasMean(file) && file.meanLength >= minMeanLength)
    && (maxMeanLength === null || hasMean(file) && file.meanLength <= maxMeanLength));
  const [field, direction] = sort.split('-'), sign = direction === 'desc' ? -1 : 1;
  return result.sort((a, b) => {
    if (field === 'sample') return sign * byName(a, b);
    if (field === 'meanLength' && hasMean(a) !== hasMean(b)) return hasMean(a) ? -1 : 1;
    const difference = field === 'meanLength' && !hasMean(a) ? 0 : (a[field] - b[field]) * sign;
    return difference || byName(a, b);
  });
}
