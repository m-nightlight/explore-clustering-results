export function CommandChip({ label, value, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? "rgba(76,201,240,0.12)" : "rgba(16,20,28,0.92)",
      backdropFilter: "blur(12px)",
      border: `1px solid ${active ? "#4CC9F0" : "#2e3440"}`,
      borderRadius: 6,
      color: active ? "#4CC9F0" : "#c9d1d9",
      cursor: "pointer",
      fontSize: 11,
      fontFamily: "monospace",
      padding: "5px 11px",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 2,
      transition: "all 0.12s",
      whiteSpace: "nowrap",
    }}>
      <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>{label}</span>
      {value && <span style={{ fontSize: 9, color: active ? "#88d8f0" : "#556677", letterSpacing: 0.2 }}>{value}</span>}
    </button>
  );
}

export function Popover({ children, style }) {
  return (
    <div style={{
      position: "absolute",
      top: "calc(100% + 4px)",
      right: 0,
      background: "rgba(16,20,28,0.97)",
      backdropFilter: "blur(12px)",
      border: "1px solid #2e3440",
      borderRadius: 6,
      boxShadow: "0 16px 48px rgba(0,0,0,0.65)",
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 7,
      minWidth: 200,
      zIndex: 30,
      fontFamily: "monospace",
      ...style,
    }}>
      {children}
    </div>
  );
}

export function PopLabel({ children }) {
  return (
    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.8, color: "#556677", fontWeight: 600, marginTop: 2 }}>
      {children}
    </div>
  );
}

export function PopRow({ children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
      {children}
    </div>
  );
}

export function PopDivider() {
  return <div style={{ height: 1, background: "#2e3440", margin: "2px 0" }} />;
}

export function ChipBtn({ children, onClick, disabled, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: "none",
      border: "1px solid #3d4555",
      borderRadius: 4,
      color: "#8b949e",
      cursor: disabled ? "default" : "pointer",
      fontSize: 10,
      fontFamily: "monospace",
      padding: "2px 7px",
      lineHeight: 1.4,
      ...style,
    }}>
      {children}
    </button>
  );
}

export function ToggleChip({ active, color, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? `${color}22` : "none",
      border: `1px solid ${active ? color : "#3d4555"}`,
      borderRadius: 4,
      color: active ? color : "#8b949e",
      cursor: "pointer",
      fontSize: 10,
      fontFamily: "monospace",
      padding: "2px 7px",
      lineHeight: 1.4,
      transition: "color 0.8s ease, border-color 0.8s ease, background 0.8s ease",
    }}>
      {children}
    </button>
  );
}
