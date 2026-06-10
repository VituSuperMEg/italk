"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { Mic, MicOff, Video, VideoOff, Users, Volume2, MessageCircle, Send, X } from "lucide-react";

const PROXIMITY_RANGE = 300;
type Peer = { id: string; displayName: string };

const emojis = [
  "😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙",
  "😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥",
  "😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐"
];
const getRandomEmoji = () => emojis[Math.floor(Math.random() * emojis.length)];

function calcSpatialVolume(dist: number): number {
  if (dist >= PROXIMITY_RANGE) return 0;
  const t = 1 - dist / PROXIMITY_RANGE;
  return Math.pow(t, 1.4);
}

// ── Components ────────────────────────────────────────────────────────────────

function VideoTile({ videoRef, label, muted, active }: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  label: string;
  muted?: boolean;
  active: boolean;
}) {
  const [hasTrack, setHasTrack] = useState(false);
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const on = () => setHasTrack(true);
    v.addEventListener("track", on);
    if (v.srcObject && (v.srcObject as MediaStream).getTracks().length > 0) on();
    return () => v.removeEventListener("track", on);
  }, [videoRef]);
  return (
    <div className="relative rounded-xl overflow-hidden bg-gray-700/40 border border-gray-600/50">
      <video ref={videoRef} className="w-full aspect-video object-cover" playsInline autoPlay muted={!!muted} />
      {(!active || !hasTrack) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
          <div className="text-center"><VideoOff className="w-8 h-8 text-gray-500 mx-auto mb-1" /><p className="text-xs text-gray-400">{label}</p></div>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-black/40 px-2 py-1">
        <p className="text-xs text-gray-200 truncate">{label}</p>
      </div>
    </div>
  );
}

// ── PeerRow ───────────────────────────────────────────────────────────────────

function PeerRow({ peer, emoji, onChat, unread }: {
  peer: Peer; emoji: string; unread?: number; onChat: (p: Peer) => void;
}) {
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 transition-colors">
      <div className="text-2xl shrink-0">{emoji}</div>
      <div className="flex-1 min-w-0">
        <div className="text-white text-sm font-medium truncate">{peer.displayName}</div>
        <div className="text-xs text-gray-400">Participante</div>
      </div>
      <div className="relative">
        <button onClick={() => onChat(peer)} className="relative p-1 text-gray-400 hover:text-blue-400 transition-colors" title="Mensagem privada">
          <MessageCircle className="w-4 h-4" />
          {unread ? (
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-[10px] font-bold text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </button>
      </div>
      <div className="w-2 h-2 bg-green-400 rounded-full shrink-0" title="Conectado" />
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, emoji, onDone }: { message: string; emoji: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className="flex items-center gap-3 bg-gray-800/90 backdrop-blur border border-gray-600/50 text-white px-4 py-3 rounded-xl shadow-2xl max-w-xs animate-in fade-in slide-in-from-top-3">
      <span className="text-2xl">{emoji}</span>
      <p className="text-sm">{message}</p>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const search = useSearchParams();
  const displayName = search.get("name") || "";
  const micParam = search.get("mic") === "true";
  const camParam = search.get("cam") === "true";

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
  const [diag, setDiag] = useState<{ connected: number; remoteAudio: number }>({ connected: 0, remoteAudio: 0 });
  const [micEnabled, setMicEnabled] = useState(micParam);
  const [camEnabled, setCamEnabled] = useState(camParam);
  const [userEmoji, setUserEmoji] = useState("");
  const [peerEmojis, setPeerEmojis] = useState<Map<string, string>>(new Map());

  const [messages, setMessages] = useState<Array<{ id: string; from: string; fromId: string; message: string; timestamp: number }>>([]);
  const [newMessage, setNewMessage] = useState("");
  const [showChat, setShowChat] = useState(false);

  const [privateMessages, setPrivateMessages] = useState<Map<string, Array<{ id: string; from: string; fromId: string; message: string; timestamp: number }>>>(new Map());
  const [showPrivateChat, setShowPrivateChat] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<Peer | null>(null);
  const [newPrivateMessage, setNewPrivateMessage] = useState("");
  const [unreadGeneralMessages, setUnreadGeneralMessages] = useState(0);
  const [unreadPrivateCounts, setUnreadPrivateCounts] = useState<Map<string, number>>(new Map());

  const [pos, setPos] = useState({ x: 250, y: 250 });
  const [keys, setKeys] = useState<Record<string, boolean>>({});

  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [nearbyIds, setNearbyIds] = useState<Set<string>>(new Set());
  const [connectionStatus, setConnectionStatus] = useState<Map<string, "connecting" | "connected" | "disconnected">>(new Map());
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; emoji: string }>>([]);

  // ── Emoji init ──────────────────────────────────────────────────────────────

  useEffect(() => { if (!userEmoji) setUserEmoji(getRandomEmoji()); }, [userEmoji]);

  // ── addTracksToPeer helper ──────────────────────────────────────────────────

  const addTracksToPeer = useCallback((pc: RTCPeerConnection, peerId: string) => {
    if (!streamRef.current) return;
    let anyAdded = false;
    streamRef.current.getTracks().forEach(track => {
      try {
        const isSending = pc.getSenders().some(s => s.track === track);
        if (!isSending) { pc.addTrack(track, streamRef.current!); anyAdded = true; }
      } catch { /* ignore */ }
    });
    if (anyAdded) console.log(`[webrtc] tracks added to peer ${peerId}`);
  }, []);

  // ── createPeer ──────────────────────────────────────────────────────────────

  const createPeer = useCallback((peerId: string, isInitiator: boolean) => {
    console.log(`[webrtc] creating peer connection to ${peerId}, initiator: ${isInitiator}`);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
        { urls: ["turn:openrelay.metered.ca:80","turn:openrelay.metered.ca:443","turns:openrelay.metered.ca:443"], username: "openrelayproject", credential: "openrelayproject" },
      ],
    });
    pcByPeer.current.set(peerId, pc);
    setConnectionStatus(prev => { const m = new Map(prev); m.set(peerId, "connecting"); return m; });

    addTracksToPeer(pc, peerId);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socketRef.current?.emit("signal", { roomId: roomId as string, targetId: peerId, data: { candidate: ev.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[webrtc] state ${peerId}:`, pc.connectionState);
      const state = pc.connectionState === "connected" ? "connected"
                  : (pc.connectionState === "disconnected" || pc.connectionState === "failed") ? "disconnected"
                  : "connecting";
      setConnectionStatus(prev => { const m = new Map(prev); m.set(peerId, state); return m; });
      setDiag(d => ({ ...d, connected: Array.from(pcByPeer.current.values()).filter(p => p.connectionState === "connected").length }));
    };

    pc.ontrack = (ev) => {
      let audio = remoteAudioByPeer.current.get(peerId);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.muted = !audioUnlocked;
        audio.volume = 1;
        (remoteContainerRef.current ?? document.body).appendChild(audio);
        remoteAudioByPeer.current.set(peerId, audio);
      }
      audio.srcObject = ev.streams[0];
      setDiag(d => ({ ...d, remoteAudio: remoteAudioByPeer.current.size }));
      const video = document.createElement("video");
      video.autoplay = true; video.playsInline = true; video.muted = true;
      video.style.width = "0px"; video.style.height = "0px";
      video.srcObject = ev.streams[0];
      (remoteContainerRef.current ?? document.body).appendChild(video);
    };

    if (isInitiator) {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
          socketRef.current?.emit("signal", { roomId: roomId as string, targetId: peerId, data: { sdp: pc.localDescription } });
        })
        .catch(e => console.error(`[webrtc] offer failed ${peerId}:`, e));
    }
    return pc;
  }, [roomId, addTracksToPeer, audioUnlocked]);

  // ── Periodic track re-hydrate ───────────────────────────────────────────────

  useEffect(() => {
    const id = setInterval(() => {
      pcByPeer.current.forEach((pc, pid) => addTracksToPeer(pc, pid));
    }, 1000);
    return () => clearInterval(id);
  }, [addTracksToPeer]);

  // ── Media setup ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ audio: true, video: camParam })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        stream.getAudioTracks().forEach(t => (t.enabled = !!micParam));
        stream.getVideoTracks().forEach(t => (t.enabled = camParam));
        if (localVideoRef.current) { localVideoRef.current.srcObject = stream; localVideoRef.current.play().catch(() => {}); }
        console.log("[client] media ready");
      })
      .catch(e => console.log("[client] getUserMedia failed:", e));
    return () => { cancelled = true; streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; };
  }, [micParam, camParam]);

  // ── Socket ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const signalUrl = process.env.NEXT_PUBLIC_SIGNAL_URL || "http://localhost:4001";
    const socket: Socket = io(signalUrl);
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[client] connected");
      socket.emit("join", { roomId, displayName });
    });

    socket.on("reconnect", () => {
      console.log("[client] reconnected");
      socket.emit("join", { roomId, displayName });
    });

    socket.on("peers", (list: Peer[]) => {
      console.log("[client] peers list:", list);
      setPeers(list);
      setPeerEmojis(prev => {
        const next = new Map(prev);
        list.forEach(p => { if (!next.has(p.id)) next.set(p.id, getRandomEmoji()); });
        return next;
      });
      list.forEach(p => {
        if (!pcByPeer.current.has(p.id)) createPeer(p.id, true);
      });
    });

    socket.on("peer-joined", (peer: Peer) => {
      console.log("[client] peer joined:", peer);
      setPeers(prev => [...prev, peer]);
      setPeerEmojis(prev => { const next = new Map(prev); if (!next.has(peer.id)) next.set(peer.id, getRandomEmoji()); return next; });
      setNotifications(prev => [...prev.slice(-3), { id: Date.now().toString(), message: `${peer.displayName} entrou na sala`, emoji: getRandomEmoji() }]);
    });

    socket.on("peer-left", ({ id }: { id: string }) => {
      const emoji = peerEmojis.get(id) || "👋";
      setNotifications(prev => [...prev.slice(-3), { id: Date.now().toString(), message: "Alguém saiu da sala", emoji }]);
      setPeers(prev => prev.filter(p => p.id !== id));
      const pc = pcByPeer.current.get(id);
      pc?.close(); pcByPeer.current.delete(id);
      const a = remoteAudioByPeer.current.get(id);
      if (a) { a.pause(); a.srcObject = null; a.remove(); }
      remoteAudioByPeer.current.delete(id);
      peerPos.current.delete(id);
      setPeerEmojis(prev => { const m = new Map(prev); m.delete(id); return m; });
      setConnectionStatus(prev => { const m = new Map(prev); m.delete(id); return m; });
      setNearbyIds(prev => { const s = new Set(prev); s.delete(id); return s; });
    });

    socket.on("signal", async ({ from, data }: { from: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      let pc = pcByPeer.current.get(from);
      if (!pc) pc = createPeer(from, false);
      if (data.sdp) {
        if (data.sdp.type === "offer") {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const queued = pendingCandidates.current.get(from);
            if (queued?.length) { queued.forEach(c => { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }); pendingCandidates.current.set(from, []); }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit("signal", { roomId: roomId as string, targetId: from, data: { sdp: pc.localDescription } });
          } catch (e) { console.error("[webrtc] offer error:", e); }
        } else if (data.sdp.type === "answer") {
          if (pc.signalingState === "have-local-offer") {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
              const queued = pendingCandidates.current.get(from);
              if (queued?.length) { queued.forEach(c => { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }); pendingCandidates.current.set(from, []); }
            } catch (e) { console.error("[webrtc] answer error:", e); }
          }
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) { try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {} }
        else { const list = pendingCandidates.current.get(from) || []; list.push(data.candidate); pendingCandidates.current.set(from, list); }
      }
    });

    socket.on("peer-pos", ({ id, x, y }: { id: string; x: number; y: number }) => {
      peerPos.current.set(id, { x, y });
    });

    socket.on("chat-message", ({ from, message, timestamp }: { from: string; message: string; timestamp: number }) => {
      setMessages(prev => [...prev, { id: `${from}-${timestamp}`, from, fromId: "peer", message, timestamp }]);
      if (!showChat) setUnreadGeneralMessages(prev => prev + 1);
    });

    socket.on("private-message", ({ from, message, timestamp, fromId }: { from: string; message: string; timestamp: number; fromId: string }) => {
      setPrivateMessages(prev => { const next = new Map(prev); const list = next.get(fromId) || []; next.set(fromId, [...list, { id: `${fromId}-${timestamp}`, from, fromId: "peer", message, timestamp }]); return next; });
      setUnreadPrivateCounts(prev => { const next = new Map(prev); next.set(fromId, (next.get(fromId) || 0) + 1); return next; });
    });

    return () => { socket.disconnect(); };
  }, [roomId, displayName, createPeer, showChat]);

  // ── Keyboard ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const down = (e: KeyboardEvent) => setKeys(k => ({ ...k, [e.key.toLowerCase()]: true }));
    const up   = (e: KeyboardEvent) => setKeys(k => ({ ...k, [e.key.toLowerCase()]: false }));
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // ── Canvas ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const ctx_ = el.getContext("2d"); if (!ctx_) return;
    const ctx = ctx_; const W = el.width, H = el.height;
    let raf = 0;
    const speed = 3;

    function frame() {
      setPos(old => {
        let { x, y } = old;
        if (!showChat) {
          if (keys.w) y -= speed; if (keys.s) y += speed;
          if (keys.a) x -= speed; if (keys.d) x += speed;
        }
        x = Math.max(20, Math.min(W - 20, x));
        y = Math.max(20, Math.min(H - 20, y));
        return { x, y };
      });

      ctx.clearRect(0, 0, W, H);

      // Grid
      ctx.fillStyle = "#1a2332";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      for (let gx = 0; gx < W; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      for (let gy = 0; gy < H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

      // Proximity rings
      for (const [, p] of peerPos.current.entries()) {
        const _pd = Math.hypot(pos.x - p.x, pos.y - p.y);
        if (_pd < PROXIMITY_RANGE) {
          ctx.beginPath(); ctx.arc(p.x, p.y, PROXIMITY_RANGE, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(99,102,241,0.15)"; ctx.stroke();
        }
      }

      // Spatial audio + nearby set
      const newNearby = new Set<string>();
      for (const [aid, ap] of peerPos.current.entries()) {
        const dist = Math.hypot(pos.x - ap.x, pos.y - ap.y);
        const vol = calcSpatialVolume(dist);
        const aud = remoteAudioByPeer.current.get(aid);
        if (aud && audioUnlocked) { aud.volume = vol; aud.muted = vol === 0; }
        if (vol > 0) newNearby.add(aid);
      }
      setNearbyIds(newNearby);

      // Remote peers
      for (const [rid, rp] of peerPos.current.entries()) {
        const peer = peers.find(pp => pp.id === rid);
        const emoji = peerEmojis.get(rid);
        const dist = Math.hypot(pos.x - rp.x, pos.y - rp.y);
        const nearby = newNearby.has(rid);
        const conn = connectionStatus.get(rid);
        if (conn === "connecting") {
          ctx.fillStyle = "rgba(251,191,36,0.3)"; ctx.beginPath(); ctx.arc(rp.x, rp.y, 38, 0, Math.PI * 2); ctx.fill();
        } else if (conn === "disconnected") {
          ctx.fillStyle = "rgba(239,68,68,0.25)"; ctx.beginPath(); ctx.arc(rp.x, rp.y, 35, 0, Math.PI * 2); ctx.fill();
        } else if (nearby) {
          ctx.fillStyle = "rgba(99,102,241,0.12)"; ctx.beginPath(); ctx.arc(rp.x, rp.y, 42, 0, Math.PI * 2); ctx.fill();
        }
        if (emoji) {
          ctx.font = "32px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(emoji, rp.x, rp.y);
        }
        if (peer) {
          ctx.font = "11px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          const tw = ctx.measureText(peer.displayName).width;
          const pad = 6, bw = tw + pad * 2, bh = 18;
          ctx.fillStyle = "rgba(0,0,0,0.8)";
          ctx.beginPath(); ctx.roundRect(rp.x - bw / 2, rp.y - 28, bw, bh, 8); ctx.fill();
          ctx.fillStyle = nearby ? "#a5b4fc" : "#ffffff";
          ctx.fillText(peer.displayName, rp.x, rp.y - 28 + bh / 2);
        }
      }

      // Local avatar
      {
        const hasNearby = Array.from(peerPos.current.values()).some(p => Math.hypot(pos.x - p.x, pos.y - p.y) < PROXIMITY_RANGE);
        if (hasNearby) {
          ctx.strokeStyle = "rgba(99,102,241,0.3)"; ctx.beginPath(); ctx.arc(pos.x, pos.y, PROXIMITY_RANGE, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.font = "32px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        if (userEmoji) ctx.fillText(userEmoji, pos.x, pos.y);
        ctx.font = "11px Arial";
        const tw2 = ctx.measureText(displayName || "Você").width;
        const pad2 = 6, bw2 = tw2 + pad2 * 2, bh2 = 18;
        ctx.fillStyle = "rgba(59,130,246,0.85)";
        ctx.beginPath(); ctx.roundRect(pos.x - bw2 / 2, pos.y - 28, bw2, bh2, 8); ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(displayName || "Você", pos.x, pos.y - 28 + bh2 / 2);
      }

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pos, keys, userEmoji, peerEmojis, peers, displayName, showChat, roomId, audioUnlocked, connectionStatus]);

  // ── Interaction handlers ────────────────────────────────────────────────────

  function handleDblClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = canvasRef.current!.width / rect.width;
    const sy = canvasRef.current!.height / rect.height;
    setPos({ x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy });
  }

  function handleCanvasClick() { if (!audioUnlocked) unlockAudio(); }

  function unlockAudio() {
    setAudioUnlocked(true);
    remoteAudioByPeer.current.forEach(a => { a.muted = false; a.volume = 1; a.play().catch(() => {}); });
  }

  // ── Position emitter ────────────────────────────────────────────────────────

  useEffect(() => {
    const socket = socketRef.current; if (!socket) return;
    const room = roomId as string;
    const id = setInterval(() => { socket.emit("pos-update", { roomId: room, x: pos.x, y: pos.y }); }, 100);
    return () => clearInterval(id);
  }, [pos, roomId]);

  // ── Device toggles ──────────────────────────────────────────────────────────

  function toggleMic() {
    const next = !micEnabled;
    setMicEnabled(next);
    streamRef.current?.getAudioTracks().forEach(t => (t.enabled = next));
  }
  function toggleCam() {
    const next = !camEnabled;
    setCamEnabled(next);
    streamRef.current?.getVideoTracks().forEach(t => (t.enabled = next));
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  function addNotification(message: string, emoji: string) {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    setNotifications(prev => [...prev.slice(-3), { id, message, emoji }]);
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  function sendMessage() {
    if (!newMessage.trim() || !socketRef.current) return;
    const msg = { id: Date.now().toString(), from: displayName || "Você", fromId: "me", message: newMessage.trim(), timestamp: Date.now() };
    setMessages(prev => [...prev, msg]);
    socketRef.current.emit("chat-message", { roomId, message: newMessage.trim(), from: displayName || "Você" });
    setNewMessage("");
  }
  function handleKeyPress(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function openPrivateChat(peer: Peer) {
    setSelectedPeer(peer);
    setShowPrivateChat(true);
    setUnreadPrivateCounts(prev => { const m = new Map(prev); m.delete(peer.id); return m; });
  }
  function closePrivateChat() { setShowPrivateChat(false); setSelectedPeer(null); }

  function sendPrivateMessage() {
    if (!newPrivateMessage.trim() || !socketRef.current || !selectedPeer) return;
    const msg = { id: Date.now().toString(), from: displayName || "Você", fromId: "me", message: newPrivateMessage.trim(), timestamp: Date.now() };
    const pid = selectedPeer.id;
    setPrivateMessages(prev => { const m = new Map(prev); m.set(pid, [...(m.get(pid) || []), msg]); return m; });
    socketRef.current.emit("private-message", { roomId, targetId: selectedPeer.id, message: newPrivateMessage.trim(), from: displayName || "Você" });
    setNewPrivateMessage("");
  }
  function handlePrivateKeyPress(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrivateMessage(); }
  }

  const peersCount = useMemo(() => peers.length, [peers]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="absolute inset-0 min-h-screen w-full bg-gradient-to-br from-gray-900 via-black to-gray-800 full-screen-bg">

      {/* Header */}
      <header className="relative z-10 bg-gray-800/50 backdrop-blur-sm border-b border-gray-700/50">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <Users className="w-4 h-4 text-white" />
              </div>
              <div><h1 className="text-white font-semibold text-sm">Sala: {String(roomId)}</h1><p className="text-gray-400 text-xs">iTalk</p></div>
            </div>
            <span className="text-xs text-gray-400 hidden sm:inline">{peersCount + 1} participantes</span>
          </div>
          <div className="flex items-center gap-3">
            {!audioUnlocked && (
              <button onClick={unlockAudio} className="relative z-20 flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm">
                <Volume2 className="w-4 h-4" /> Habilitar áudio
              </button>
            )}
            <button onClick={() => { setShowChat(!showChat); if (!showChat) setUnreadGeneralMessages(0); }}
              className="relative z-20 flex items-center gap-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm">
              <MessageCircle className="w-4 h-4" /> Chat
              {unreadGeneralMessages > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] bg-red-500 rounded-full flex items-center justify-center text-[10px] font-bold px-1">
                  {unreadGeneralMessages > 99 ? "99+" : unreadGeneralMessages}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="relative z-10 flex-1 p-4 flex flex-col">
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 flex-1">

          {/* Canvas */}
          <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 overflow-hidden flex flex-col">
            <div className="px-3 py-2 border-b border-gray-700/50 flex items-center justify-between text-xs text-gray-400">
              <div>Conexões: {diag.connected} | Áudio: {diag.remoteAudio} | {nearbyIds.size} próximos</div>
              <div className="text-gray-500">WASD mover • Clique ativar áudio • Duplo clique teleportar</div>
            </div>
            <div className="relative flex-1">
              <canvas ref={canvasRef} width={800} height={500} onClick={handleCanvasClick} onDoubleClick={handleDblClick}
                className="w-full h-full bg-gray-900 cursor-crosshair" />
            </div>
          </div>

          {/* Sidebar */}
          <aside className="flex flex-col gap-4">
            <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-700/50"><h3 className="text-white font-medium text-sm">Seu vídeo</h3></div>
              <VideoTile videoRef={localVideoRef} label={displayName || "Você"} active={camEnabled} muted />
            </div>
            <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 p-4">
              <h3 className="text-white font-medium text-sm mb-3">Controles</h3>
              <div className="space-y-2">
                <button onClick={toggleMic}
                  className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm transition-all ${micEnabled ? "bg-green-600/20 border-green-500 text-green-400 hover:bg-green-600/30" : "bg-gray-900/50 border-gray-600 text-gray-400 hover:bg-gray-800/50"}`}>
                  {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                  <span className="font-medium">{micEnabled ? "Microfone Ligado" : "Microfone Desligado"}</span>
                </button>
                <button onClick={toggleCam}
                  className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm transition-all ${camEnabled ? "bg-green-600/20 border-green-500 text-green-400 hover:bg-green-600/30" : "bg-gray-900/50 border-gray-600 text-gray-400 hover:bg-gray-800/50"}`}>
                  {camEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                  <span className="font-medium">{camEnabled ? "Câmera Ligada" : "Câmera Desligada"}</span>
                </button>
              </div>
            </div>
            <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 p-4 flex-1 overflow-y-auto">
              <h3 className="text-white font-medium text-sm mb-3 flex items-center gap-2"><Users className="w-4 h-4" /> Participantes</h3>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2.5 p-2 rounded-lg bg-gray-700/20">
                  <span className="text-xl">{userEmoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-sm font-medium truncate">{displayName || "Você"}</div>
                    <div className="text-gray-500 text-xs">Você</div>
                  </div>
                </div>
                {peers.map(p => (
                  <PeerRow key={p.id} peer={p} emoji={peerEmojis.get(p.id) || "🤖"} unread={unreadPrivateCounts.get(p.id)} onChat={openPrivateChat} />
                ))}
                {peers.length === 0 && <p className="text-center text-gray-500 text-sm py-4">Apenas você na sala</p>}
              </div>
              {nearbyIds.size > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-700/50">
                  <p className="text-xs text-gray-400 mb-2 flex items-center gap-1"><Volume2 className="w-3 h-3" /> Perto de você (áudio espacial)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(nearbyIds).map(id => {
                      const p = peers.find(pp => pp.id === id); if (!p) return null;
                      const coords = peerPos.current.get(id); if (!coords) return null;
                      const dist = Math.round(Math.hypot(pos.x - coords.x, pos.y - coords.y));
                      return (
                        <span key={id} className="inline-flex items-center gap-1 px-2 py-1 bg-blue-900/40 border border-blue-500/30 rounded-lg text-xs text-blue-200">
                          {peerEmojis.get(id)} <span className="truncate max-w-[80px]">{p.displayName}</span><span className="text-blue-400">{dist}px</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>

      {/* Chat */}
      {showChat && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-2xl border border-gray-700/50 w-full max-w-md h-[600px] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-700/50">
              <h3 className="text-white font-medium">Chat da Sala</h3>
              <button onClick={() => setShowChat(false)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (
                <div className="text-center text-gray-500 py-8"><MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50" /><p>Nenhuma mensagem ainda</p><p className="text-sm">Seja o primeiro!</p></div>
              ) : messages.map(m => (
                <div key={m.id} className={`flex ${m.fromId === "me" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] p-3 rounded-lg ${m.fromId === "me" ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-100"}`}>
                    {m.fromId !== "me" && <div className="text-xs text-gray-300 mb-1">{m.from}</div>}
                    <div className="text-sm">{m.message}</div>
                    <div className={`text-xs mt-1 ${m.fromId === "me" ? "text-blue-200" : "text-gray-400"}`}>
                      {new Date(m.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-gray-700/50">
              <div className="flex gap-2">
                <input type="text" value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyPress={handleKeyPress} placeholder="Digite sua mensagem..."
                  className="flex-1 bg-gray-700 text-white placeholder-gray-400 px-3 py-2 rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none text-sm" />
                <button onClick={sendMessage} disabled={!newMessage.trim()}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm flex items-center gap-1">
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Private Chat */}
      {showPrivateChat && selectedPeer && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-2xl border border-gray-700/50 w-full max-w-md h-[600px] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-700/50">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{peerEmojis.get(selectedPeer.id)}</span>
                <div><h3 className="text-white font-medium">Chat com {selectedPeer.displayName}</h3><p className="text-gray-400 text-xs">Mensagem privada</p></div>
              </div>
              <button onClick={() => { setShowPrivateChat(false); setSelectedPeer(null); }} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {(!privateMessages.get(selectedPeer.id) || privateMessages.get(selectedPeer.id)!.length === 0) ? (
                <div className="text-center text-gray-500 py-8"><MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50" /><p>Sem mensagens</p><p className="text-sm">Inicie a conversa!</p></div>
              ) : privateMessages.get(selectedPeer.id)!.map(m => (
                <div key={m.id} className={`flex ${m.fromId === "me" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] p-3 rounded-lg ${m.fromId === "me" ? "bg-purple-600 text-white" : "bg-gray-700 text-gray-100"}`}>
                    {m.fromId !== "me" && <div className="text-xs text-gray-300 mb-1">{m.from}</div>}
                    <div className="text-sm">{m.message}</div>
                    <div className={`text-xs mt-1 ${m.fromId === "me" ? "text-purple-200" : "text-gray-400"}`}>
                      {new Date(m.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-gray-700/50">
              <div className="flex gap-2">
                <input type="text" value={newPrivateMessage} onChange={e => setNewPrivateMessage(e.target.value)} onKeyPress={handlePrivateKeyPress}
                  placeholder={`Mensagem para ${selectedPeer.displayName}...`}
                  className="flex-1 bg-gray-700 text-white placeholder-gray-400 px-3 py-2 rounded-lg border border-gray-600 focus:border-purple-500 focus:outline-none text-sm" />
                <button onClick={sendPrivateMessage} disabled={!newPrivateMessage.trim()}
                  className="px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm flex items-center gap-1">
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed top-20 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {notifications.map(n => (
          <Toast key={n.id} message={n.message} emoji={n.emoji}
            onDone={() => setNotifications(prev => prev.filter(x => x.id !== n.id))} />
        ))}
      </div>

      <div ref={remoteContainerRef} className="hidden" />
    </div>
  );
}
