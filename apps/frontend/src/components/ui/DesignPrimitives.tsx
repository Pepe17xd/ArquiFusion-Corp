import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function PageHeader({ kicker, title, description, status }: { kicker: string; title: string; description: string; status?: ReactNode }) {
  return <header className="page-intro"><div><div className="eyebrow">{kicker}</div><h1>{title}</h1><p>{description}</p></div>{status && <div className="page-intro-status">{status}</div>}</header>;
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <fieldset className="design-form-section"><legend>{title}</legend>{description && <p>{description}</p>}<div>{children}</div></fieldset>;
}

type LabeledProps = { label: string; hint?: string; error?: string; id?: string };
export function TextInput({ label, hint, error, id: suppliedId, ...props }: LabeledProps & InputHTMLAttributes<HTMLInputElement>) {
  const generated = useId(); const id = suppliedId ?? generated; const hintId = hint ? `${id}-hint` : undefined; const errorId = error ? `${id}-error` : undefined;
  return <label className="design-field" htmlFor={id}><span>{label}</span><input id={id} aria-invalid={Boolean(error)} aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined} {...props}/>{hint && <small id={hintId}>{hint}</small>}{error && <small className="design-field-error" id={errorId}>{error}</small>}</label>;
}

export function SelectField({ label, hint, error, id: suppliedId, children, ...props }: LabeledProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const generated = useId(); const id = suppliedId ?? generated; const hintId = hint ? `${id}-hint` : undefined; const errorId = error ? `${id}-error` : undefined;
  return <label className="design-field" htmlFor={id}><span>{label}</span><select id={id} aria-invalid={Boolean(error)} aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined} {...props}>{children}</select>{hint && <small id={hintId}>{hint}</small>}{error && <small className="design-field-error" id={errorId}>{error}</small>}</label>;
}

export function TextAreaField({ label, hint, error, id: suppliedId, ...props }: LabeledProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const generated = useId(); const id = suppliedId ?? generated; const hintId = hint ? `${id}-hint` : undefined; const errorId = error ? `${id}-error` : undefined;
  return <label className="design-field" htmlFor={id}><span>{label}</span><textarea id={id} aria-invalid={Boolean(error)} aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined} {...props}/>{hint && <small id={hintId}>{hint}</small>}{error && <small className="design-field-error" id={errorId}>{error}</small>}</label>;
}

export function PrimaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`af-button-primary ${className}`.trim()} {...props}/>;
}

export function SecondaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`af-button-secondary ${className}`.trim()} {...props}/>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="af-empty-state"><span aria-hidden="true">—</span><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}

export function LoadingSkeleton({ rows = 3, label = "Cargando" }: { rows?: number; label?: string }) {
  return <div className="af-skeleton-list" role="status" aria-label={label}>{Array.from({ length: Math.max(1, Math.min(rows, 8)) }, (_, index) => <i key={index}/>)}</div>;
}

export function ErrorState({ title = "No pudimos cargar esta información", description, onRetry }: { title?: string; description: string; onRetry?: () => void }) {
  return <section className="af-error-state" role="alert"><strong>{title}</strong><p>{description}</p>{onRetry && <SecondaryButton onClick={onRetry}>Volver a intentar</SecondaryButton>}</section>;
}
