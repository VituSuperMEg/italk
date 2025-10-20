"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";

type Peer = { id: string; displayName: string };

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const search = useSearchParams();
  const displayName = search.get("name") || "";
  const mic = search.get("mic") === "true";
  const cam = search.get("cam") === "true";

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const remoteContainerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const pcByPeer = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioByPeer = useRef<Map<string, HTMLAudioElement>>(new Map());
  const peerPos = useRef<Map<string, { x: number; y: number }>>(new Map());
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const streamRef = useRef<MediaStream | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [readyToCall, setReadyToCall] = useState(true); // Force ready to call
  const pendingInitiate = useRef<Set<string>>(new Set());
  const [diag, setDiag] = useState<{ connected: number; remoteAudio: number }>(
    { connected: 0, remoteAudio: 0 }
  );

  // Basic movement state
  const [pos, setPos] = useState({ x: 100, y: 100 });
  const [keys, setKeys] = useState<Record<string, boolean>>({});

  // Setup media - simplified
  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: cam })
      .then((stream) => {
        if (cancelled) return;
        streamRef.current = stream;
        stream.getAudioTracks().forEach((t) => (t.enabled = !!mic));
        stream.getVideoTracks().forEach((t) => (t.enabled = cam));
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.play().catch(() => {});
        }
        console.log("[client] media ready, processing pending connections");
        // process any deferred initiations
        if (pendingInitiate.current.size) {
          for (const id of Array.from(pendingInitiate.current)) {
            if (!pcByPeer.current.has(id)) createPeer(id, true);
          }
          pendingInitiate.current.clear();
        }
      })
      .catch((e) => {
        console.log("[client] getUserMedia failed:", e);
        // Continue anyway - we'll try to connect without local media
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mic, cam]);

  // Socket + signaling
  useEffect(() => {
    const signalUrl = process.env.NEXT_PUBLIC_SIGNAL_URL || "http://localhost:4001";
    const socket = io(signalUrl);
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[client] connected to signaling server");
      // Emit join immediately, no delay needed
      console.log("[client] emitting join event");
      socket.emit("join", { roomId, displayName });
    });

    // Also try to join on reconnect
    socket.on("reconnect", () => {
      console.log("[client] reconnected, joining room");
      socket.emit("join", { roomId, displayName });
    });

    socket.on("peers", (list: Peer[]) => {
      console.log("[client] received peers list:", list);
      setPeers(list);
      // I am the newcomer; I initiate offers to existing peers only here
      list.forEach((p) => {
        if (!pcByPeer.current.has(p.id)) {
          console.log(`[client] initiating connection to peer ${p.id}, readyToCall: ${readyToCall}`);
          if (readyToCall) {
            console.log(`[client] calling createPeer for ${p.id}`);
            createPeer(p.id, true);
          } else {
            console.log(`[client] adding ${p.id} to pending list`);
            pendingInitiate.current.add(p.id);
          }
        }
      });
    });
    // Existing peers should NOT initiate; they will just respond when they receive an offer
    socket.on("peer-joined", (peer: Peer) => {
      console.log("[client] peer joined:", peer);
      setPeers((p) => [...p, peer]);
    });
    socket.on("peer-left", ({ id }: { id: string }) => {
      setPeers((prev) => prev.filter((p) => p.id !== id));
      const pc = pcByPeer.current.get(id);
      pc?.close();
      pcByPeer.current.delete(id);
      const a = remoteAudioByPeer.current.get(id);
      if (a) {
        a.pause();
        a.srcObject = null;
        a.remove();
      }
      remoteAudioByPeer.current.delete(id);
      peerPos.current.delete(id);
    });

    socket.on("signal", async ({ from, data }: { from: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      let pc = pcByPeer.current.get(from);
      if (!pc) pc = createPeer(from, false);
      if (data.sdp) {
        if (data.sdp.type === "offer") {
          await pc.setRemoteDescription(data.sdp);
          const queued = pendingCandidates.current.get(from);
          if (queued && queued.length) {
            for (const c of queued) {
              try { await pc.addIceCandidate(c); } catch {}
            }
            pendingCandidates.current.set(from, []);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("signal", { roomId, targetId: from, data: { sdp: pc.localDescription } });
        } else if (data.sdp.type === "answer") {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(data.sdp);
            const queued = pendingCandidates.current.get(from);
            if (queued && queued.length) {
              for (const c of queued) {
                try { await pc.addIceCandidate(c); } catch {}
              }
              pendingCandidates.current.set(from, []);
            }
          }
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch {}
        } else {
          const list = pendingCandidates.current.get(from) || [];
          list.push(data.candidate);
          pendingCandidates.current.set(from, list);
        }
      }
    });

    // position updates
    socket.on("peer-pos", ({ id, x, y }: { id: string; x: number; y: number }) => {
      peerPos.current.set(id, { x, y });
    });

    return () => {
      socket.disconnect();
    };
  }, [roomId, displayName]);

  function createPeer(peerId: string, isInitiator: boolean) {
    console.log(`[webrtc] creating peer connection to ${peerId}, initiator: ${isInitiator}`);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
        {
          urls: [
            "turn:openrelay.metered.ca:80",
            "turn:openrelay.metered.ca:443",
            "turns:openrelay.metered.ca:443",
          ],
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ],
    });
    pcByPeer.current.set(peerId, pc);

    streamRef.current?.getTracks().forEach((track) => {
      const s = streamRef.current!;
      pc.addTrack(track, s);
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socketRef.current?.emit("signal", {
          roomId,
          targetId: peerId,
          data: { candidate: ev.candidate },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[webrtc] connection state for ${peerId}:`, pc.connectionState);
      setDiag((d) => ({ ...d, connected: Array.from(pcByPeer.current.values()).filter(p => p.connectionState === "connected").length }));
    };

    pc.ontrack = (ev) => {
      console.log(`[webrtc] received track from ${peerId}:`, ev.streams[0]);
      let audio = remoteAudioByPeer.current.get(peerId);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        // @ts-expect-error playsInline exists on HTMLMediaElement in browsers11
        audio.playsInline = true;
        audio.muted = false;
        // will remain muted until a click gesture occurs; volume adjusted by proximity
        (remoteContainerRef.current ?? document.body).appendChild(audio);
        remoteAudioByPeer.current.set(peerId, audio);
        console.log(`[webrtc] created audio element for ${peerId}`);
      }
      audio.srcObject = ev.streams[0];
      // try to start playback immediately (may be blocked until unlock)
      audio.volume = 1;
      audio.play().then(() => {
        console.log(`[webrtc] audio playing for ${peerId}`);
      }).catch((e) => {
        console.log(`[webrtc] audio play failed for ${peerId}:`, e);
      });
      setDiag((d) => ({ ...d, remoteAudio: remoteAudioByPeer.current.size }));

      // Optional: attach a hidden video to ensure video pipeline is active
      const video = document.createElement("video");
      video.autoplay = true;
      (video as unknown as HTMLVideoElement).playsInline = true;
      video.muted = true;
      video.style.width = "0px";
      video.style.height = "0px";
      video.srcObject = ev.streams[0];
      (remoteContainerRef.current ?? document.body).appendChild(video);
      setDiag((d) => ({ ...d, remoteAudio: remoteAudioByPeer.current.size }));
    };

    if (isInitiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          socketRef.current?.emit("signal", {
            roomId,
            targetId: peerId,
            data: { sdp: pc.localDescription },
          });
        });
    }
    return pc;
  }

  // Removed peers-driven initiator effect to avoid glare

  // Movement input
  useEffect(() => {
    const down = (e: KeyboardEvent) => setKeys((k) => ({ ...k, [e.key.toLowerCase()]: true }));
    const up = (e: KeyboardEvent) => setKeys((k) => ({ ...k, [e.key.toLowerCase()]: false }));
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    const el = canvasRef.current!;
    const ctx = el.getContext("2d");
    if (!el || !ctx) return;

    let raf = 0;
    const speed = 3;
    function frame() {
      setPos((old) => {
        let { x, y } = old;
        if (keys["w"]) y -= speed;
        if (keys["s"]) y += speed;
        if (keys["a"]) x -= speed;
        if (keys["d"]) x += speed;
        return { x, y };
      });
      // draw
      ctx!.clearRect(0, 0, el!.width, el!.height);
      ctx!.fillStyle = "#1f2937";
      ctx!.fillRect(0, 0, el!.width, el!.height);
      ctx!.fillStyle = "#22c55e";
      ctx!.beginPath();
      ctx!.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
      ctx!.fill();

      // draw peers
      ctx!.fillStyle = "#60a5fa";
      for (const [id, p] of peerPos.current.entries()) {
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx!.fill();

        // proximity-based volume (max at 0..1), falloff after 300px
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        const dist = Math.hypot(dx, dy);
        // Temporarily force full volume to validate audio path
        const audio = remoteAudioByPeer.current.get(id);
        if (audio) audio.volume = 1;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [keys, pos.x, pos.y]);

  // Double click to move
  function handleDblClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setPos({ x, y });
  }

  // also unlock audio on first canvas click
  function handleCanvasClick() {
    if (!audioUnlocked) unlockAudio();
  }

  // emit my position throttled
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const room = roomId as string;
    const id = setInterval(() => {
      socket.emit("pos-update", { roomId: room, x: pos.x, y: pos.y });
    }, 100);
    return () => clearInterval(id);
  }, [pos.x, pos.y, roomId]);

  // user gesture to enable audio playback
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  function unlockAudio() {
    setAudioUnlocked(true);
    for (const a of remoteAudioByPeer.current.values()) {
      a.muted = false;
      a.play().catch(() => {});
    }
  }

  const peersCount = useMemo(() => peers.length, [peers]);

  return (
    <div className="min-h-dvh p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-500">Sala: {String(roomId)}</div>
        <div className="flex items-center gap-2 text-sm">
          <span>Participantes: {peersCount + 1}</span>
          {!audioUnlocked && (
            <button className="px-2 py-1 rounded border" onClick={unlockAudio}>Habilitar áudio</button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-4">
        <div className="rounded-lg border overflow-hidden">
          <div className="px-2 py-1 text-xs text-gray-400">Conn: {diag.connected} | Remote audio: {diag.remoteAudio}</div>
          <canvas
            ref={canvasRef}
            width={800}
            height={500}
            onClick={handleCanvasClick}
            onDoubleClick={handleDblClick}
            className="w-full h-[50dvh] md:h-[60dvh] bg-black"
          />
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-lg overflow-hidden border aspect-video bg-black">
            <video ref={localVideoRef} className="w-full h-full object-cover" muted playsInline />
          </div>
          <div ref={remoteContainerRef} className="hidden" />
          <div className="grid grid-cols-2 gap-2">
            <button
              className="px-3 py-2 rounded-md border"
              onClick={() => {
                streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
              }}
            >
              Liga/Desliga Microfone
            </button>
            <button
              className="px-3 py-2 rounded-md border"
              onClick={() => {
                streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
              }}
            >
              Liga/Desliga Câmera
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


