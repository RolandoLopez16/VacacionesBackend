export type LocalDate = `${number}-${number}-${number}`;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseLocalDate(value: string): LocalDate {
  const match = ISO.exec(value);
  if (!match) throw new Error(`Invalid LocalDate: ${value}`);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`Invalid LocalDate: ${value}`);
  return value as LocalDate;
}
export function today(): LocalDate { return new Date().toISOString().slice(0, 10) as LocalDate; }
export function toUtc(value: LocalDate): Date { const [y,m,d] = value.split('-').map(Number); return new Date(Date.UTC(y!,m!-1,d!)); }
export function fromUtc(value: Date): LocalDate { return value.toISOString().slice(0,10) as LocalDate; }
export function addDays(value: LocalDate, days: number): LocalDate { const d=toUtc(value); d.setUTCDate(d.getUTCDate()+days); return fromUtc(d); }
export function daysBetween(start: LocalDate, end: LocalDate): number { return Math.round((toUtc(end).getTime()-toUtc(start).getTime())/86400000); }
export function addMonths(value: LocalDate, months: number): LocalDate { const [y,m,d]=value.split('-').map(Number); const date=new Date(Date.UTC(y!,m!-1,1)); date.setUTCMonth(date.getUTCMonth()+months); const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate(); date.setUTCDate(Math.min(d!,last)); return fromUtc(date); }
export function addYearsAnniversary(value: LocalDate, years: number): LocalDate { const [y,m,d]=value.split('-').map(Number); const targetYear=y!+years; const targetDay=m===2&&d===29&&!isLeap(targetYear)?28:d!; return parseLocalDate(`${targetYear}-${String(m).padStart(2,'0')}-${String(targetDay).padStart(2,'0')}`); }
function isLeap(year:number):boolean{return year%4===0&&(year%100!==0||year%400===0)}
export function formatDate(value: LocalDate): string { const [y,m,d]=value.split('-'); return `${d}/${m}/${y}`; }
