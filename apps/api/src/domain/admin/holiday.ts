import type { LocalDate } from '../shared/localDate.js';
export interface Holiday { id:string; date:LocalDate; name:string; country:string; active:boolean; createdAt:string; updatedAt:string; }
