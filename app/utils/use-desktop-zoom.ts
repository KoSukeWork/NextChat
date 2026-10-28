import { useEffect, useRef } from "react";
import { create } from "zustand";
import { getClientConfig } from "../config/client";
import { useAppConfig } from "../store/config";
import Locale from "../locales";
import { showToast } from "../components/ui-lib";
import { normalizeZoom, registerZoomShortcuts, zoomPercent } from "./zoom";

// Runtime capability, intentionally not persisted across app/platform changes.
export const useZoomSupport = create(() => ({ supported: false }));

export function useDesktopZoom() {
  const zoom = useAppConfig((state) => normalizeZoom(state.zoom));
  const supported = useZoomSupport((state) => state.supported);
  const pending = useRef<Promise<void>>(Promise.resolve());

  useEffect(
    () => () => {
      useZoomSupport.setState({ supported: false });
    },
    [],
  );

  useEffect(() => {
    if (!getClientConfig()?.isApp || !window.__TAURI__) {
      useZoomSupport.setState({ supported: false });
      return;
    }
    let active = true;
    // Keep native calls ordered; skip obsolete queued values during rapid input.
    pending.current = pending.current.then(async () => {
      if (!active) return;
      try {
        const result = await window.__TAURI__!.invoke("set_zoom", {
          factor: zoom,
        });
        if (active) useZoomSupport.setState({ supported: result === true });
      } catch (error) {
        if (active) {
          console.error("[Zoom] Failed to set native zoom", error);
          useZoomSupport.setState({ supported: false });
        }
      }
    });
    return () => {
      active = false;
    };
  }, [zoom]);

  useEffect(() => {
    if (!supported || !getClientConfig()?.isApp || !window.__TAURI__) return;
    return registerZoomShortcuts({
      isMac: /mac/i.test(navigator.platform),
      getZoom: () => useAppConfig.getState().zoom,
      onZoom: (factor) => {
        useAppConfig.getState().update((config) => {
          config.zoom = factor;
        });
        showToast(Locale.Settings.Zoom.Toast(zoomPercent(factor)));
      },
    });
  }, [supported]);
}
