import { AlertOctagon, Check, X } from "lucide-react";

export function FeedbackBanner({ kind, children, onDismiss }: { kind: "error" | "success"; children: React.ReactNode; onDismiss?: () => void }) {
  const Icon = kind === "error" ? AlertOctagon : Check;
  return (
    <div className={"feedback-banner " + kind} role={kind === "error" ? "alert" : "status"}>
      <Icon size={16}/><span>{children}</span>
      {onDismiss && <button className="icon-button" aria-label="Cerrar aviso" onClick={onDismiss}><X size={15}/></button>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={"skeleton " + className} aria-hidden="true"/>;
}
