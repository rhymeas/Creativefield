export type AuditRow={raw:number;inline:number;look:number};
/** Raw controls, inline styles and look properties in feature CSS, per file, outside src/ds. */
export function auditDesignSystem(root?:string):Record<string,AuditRow>;
