export type UserRole='ADMIN'|'HR'|'VIEWER'|'READ_ONLY';
export interface User { id:string; username:string; passwordHash:string; passwordSalt:string; role:UserRole; active:boolean; createdAt:string; updatedAt:string; }
