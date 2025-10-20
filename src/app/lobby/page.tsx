"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function LobbyPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [enableMic, setEnableMic] = useState(true);
  const [enableCam, setEnableCam] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function setupPreview() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: enableMic,
          video: enableCam,
        });
        if (cancelled) return;
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        stream.getAudioTracks().forEach((t) => (t.enabled = enableMic));
        stream.getVideoTracks().forEach((t) => (t.enabled = enableCam));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg || "Falha ao acessar dispositivos");
      }
    }
    setupPreview();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [enableMic, enableCam]);

  const canJoin = useMemo(() => displayName.trim().length >= 2, [displayName]);

  function handleJoin() {
    const roomId = "general"; 
    const params = new URLSearchParams({
      name: displayName.trim(),
      mic: String(enableMic),
      cam: String(enableCam),
    });
    router.push(`/room/${roomId}?${params.toString()}`);
  }

  return (
    <div className="min-h-dvh p-6 flex flex-col items-center gap-6">
      <h1 className="text-2xl font-semibold">iTalk Lobby</h1>
      <div className="w-full max-w-md flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm">Seu nome</span>
          <input
            className="rounded-md border px-3 py-2 bg-transparent"
            placeholder="Ex: Ana Silva"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        <div className="flex items-center justify-between gap-4">
          <button
            className={`px-4 py-2 rounded-md border ${enableMic ? "bg-green-600 text-white" : "bg-transparent"}`}
            onClick={() => setEnableMic((v) => !v)}
          >
            {enableMic ? "Microfone: ON" : "Microfone: OFF"}
          </button>
          <button
            className={`px-4 py-2 rounded-md border ${enableCam ? "bg-green-600 text-white" : "bg-transparent"}`}
            onClick={() => setEnableCam((v) => !v)}
          >
            {enableCam ? "Câmera: ON" : "Câmera: OFF"}
          </button>
        </div>

        <div className="rounded-lg overflow-hidden border aspect-video bg-black flex items-center justify-center">
          <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
        </div>

        {error && <p className="text-red-500 text-sm">{error}</p>}

        <button
          disabled={!canJoin}
          onClick={handleJoin}
          className="px-4 py-2 rounded-md border bg-foreground text-background disabled:opacity-50"
        >
          Entrar na sala
        </button>
      </div>
    </div>
  );
}


