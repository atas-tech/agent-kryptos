import { Check, Copy } from "lucide-react";
import { useState } from "react";

interface ResourceLabelProps {
  value: string;
  truncateAt?: number;
  className?: string;
  showCopy?: boolean;
}

export function ResourceLabel({ 
  value, 
  truncateAt = 12, 
  className = "", 
  showCopy = true 
}: ResourceLabelProps) {
  const [copied, setCopied] = useState(false);

  if (!value || value === "n/a") {
    return <span className="record-meta">{value ?? "n/a"}</span>;
  }

  const shouldTruncate = value.length > truncateAt * 2;
  const displayValue = shouldTruncate 
    ? `${value.slice(0, truncateAt)}...${value.slice(-truncateAt)}` 
    : value;

  async function handleCopy(event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={`resource-label ${className} ${showCopy ? "resource-label--has-copy" : ""}`}>
      <code className="resource-label__code" title={value}>
        {displayValue}
      </code>
      {showCopy && (
        <button 
          className="resource-label__copy" 
          onClick={(e) => void handleCopy(e)} 
          type="button"
          aria-label="Copy to clipboard"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}
