interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: "success" | "warning" | "danger" | "neutral";
  children: string;
}

export function StatusBadge({ tone, children, ...props }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`} {...props}>{children}</span>;
}
