import { useToast } from './Toast.jsx';

export function CopyButton({ text, label = 'Copy', style }) {
  const toast = useToast();

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy — please copy manually.');
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: '6px',
        color: 'var(--text-muted)', fontSize: '0.65rem', padding: '0.2rem 0.55rem', cursor: 'pointer',
        fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.03em', flexShrink: 0,
        ...style,
      }}
    >
      {label}
    </button>
  );
}
