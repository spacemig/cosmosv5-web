import { useEffect, useState } from "react";

// Shared button style used across the control panels and config views.
export const btnStyle = {
  flex: 1, background: "rgba(143,215,255,0.1)", border: "1px solid rgba(143,215,255,0.3)",
  color: "#cfe6ff", borderRadius: 4, padding: "6px 10px", fontSize: 12, cursor: "pointer",
  fontFamily: "'IBM Plex Mono',monospace",
};

// Tracks whether the viewport is phone-sized, so the layout can move the
// floating control/telemetry panels into a collapsible bottom sheet.
export function useIsMobile(breakpoint = 760) {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return isMobile;
}
