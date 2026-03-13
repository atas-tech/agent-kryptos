import type { InputHTMLAttributes, ReactNode } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  icon: ReactNode;
  trailing?: ReactNode;
}

export function FormField({ label, hint, icon, trailing, ...props }: FormFieldProps) {
  return (
    <label className="form-field">
      <span className="form-field__label">{label}</span>
      <span className="form-field__control">
        <span className="form-field__icon">{icon}</span>
        <input aria-label={label} {...props} />
        {trailing ? <span className="form-field__trailing">{trailing}</span> : null}
      </span>
      {hint ? <span className="form-field__hint">{hint}</span> : null}
    </label>
  );
}
