"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { Mic, MicOff, Video, VideoOff, Users, Volume2 } from "lucide-react";

type Peer = { id: string; displayName: string };

const emojis = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🤧", "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "🤨", "🤪", "🤩", "🥰", "😍", "🤗", "🤔", "🤫", "🤭", "🤤", "😴", "😪", "😌", "😔", "😏", "😒", "🙄", "😬", "🤥", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥", "🤐", "🤨", "😐", "😑", "😶"];

const getRandomEmoji = () => {
  return emojis[Math.floor(Math.random() * emojis.length)];
};

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
  const [readyToCall] = useState(true); // Force ready to call
  const pendingInitiate = useRef<Set<string>>(new Set());
  const [diag, setDiag] = useState<{ connected: number; remoteAudio: number }>(
    { connected: 0, remoteAudio: 0 }
  );
  const [micEnabled, setMicEnabled] = useState(mic);
  const [camEnabled, setCamEnabled] = useState(cam);
  const [userEmoji, setUserEmoji] = useState("");
  const [peerEmojis, setPeerEmojis] = useState<Map<string, string>>(new Map());

  // Basic movement state
  const [pos, setPos] = useState({ x: 100, y: 100 });
  const [keys, setKeys] = useState<Record<string, boolean>>({});

  // Inicializar emoji do usuário
  useEffect(() => {
    if (!userEmoji) {
      setUserEmoji(getRandomEmoji());
    }
  }, [userEmoji]);

  const createPeer = useCallback((peerId: string, isInitiator: boolean) => {
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
  }, [roomId]);

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
  }, [mic, cam, createPeer]);

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
      
      // Atribuir emojis aleatórios para novos peers
      setPeerEmojis(prev => {
        const newMap = new Map(prev);
        list.forEach(peer => {
          if (!newMap.has(peer.id)) {
            newMap.set(peer.id, getRandomEmoji());
          }
        });
        return newMap;
      });
      
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
      
      // Atribuir emoji para o novo peer
      setPeerEmojis(prev => {
        const newMap = new Map(prev);
        if (!newMap.has(peer.id)) {
          newMap.set(peer.id, getRandomEmoji());
        }
        return newMap;
      });
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
      
      // Remover emoji do peer que saiu
      setPeerEmojis(prev => {
        const newMap = new Map(prev);
        newMap.delete(id);
        return newMap;
      });
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
  }, [roomId, displayName, readyToCall, createPeer]);

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
      
      // Configurar fonte para emojis
      ctx!.font = "32px Arial";
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";

      // Desenhar emoji do usuário (sem tag de nome para você mesmo)
      if (userEmoji) {
        ctx!.fillText(userEmoji, pos.x, pos.y);
      }

      // Desenhar peers com emojis e nomes
      for (const [id, p] of peerPos.current.entries()) {
        const peer = peers.find(peer => peer.id === id);
        const emoji = peerEmojis.get(id);
        
        if (emoji) {
          // Desenhar emoji do peer
          ctx!.fillText(emoji, p.x, p.y);
          
          // Desenhar nome do peer acima do emoji
          if (peer) {
            ctx!.font = "11px Arial";
            ctx!.textAlign = "center";
            ctx!.textBaseline = "middle";
            
            // Medir o texto para centralizar perfeitamente
            const textWidth = ctx!.measureText(peer.displayName).width;
            const padding = 6;
            const bgWidth = textWidth + padding * 2;
            const bgHeight = 18;
            const bgX = p.x - bgWidth/2;
            const bgY = p.y - 25;
            
            // Fundo arredondado para o nome
            ctx!.fillStyle = "rgba(0, 0, 0, 0.8)";
            ctx!.beginPath();
            ctx!.roundRect(bgX, bgY, bgWidth, bgHeight, 8);
            ctx!.fill();
            
            // Nome centralizado
            ctx!.fillStyle = "#ffffff";
            ctx!.fillText(peer.displayName, p.x, bgY + bgHeight/2);
            
            // Resetar fonte
            ctx!.font = "32px Arial";
            ctx!.fillStyle = "#000000";
          }
        }

        // Temporarily force full volume to validate audio path
        const audio = remoteAudioByPeer.current.get(id);
        if (audio) audio.volume = 1;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [keys, pos.x, pos.y, userEmoji, peerEmojis, peers, displayName]);

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

  // Funções de controle dos dispositivos
  function toggleMic() {
    const newState = !micEnabled;
    setMicEnabled(newState);
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = newState));
  }

  function toggleCam() {
    const newState = !camEnabled;
    setCamEnabled(newState);
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = newState));
  }


  const peersCount = useMemo(() => peers.length, [peers]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-800">
      {/* Header */}
      <div className="bg-gray-800/50 backdrop-blur-sm border-b border-gray-700/50">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <Users className="w-4 h-4 text-white" />
              </div>
              <div>
                <h1 className="text-white font-semibold">Sala: {String(roomId)}</h1>
                <p className="text-gray-400 text-sm">iTalk</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-gray-300">
              <Users className="w-4 h-4" />
              <span>{peersCount + 1} participantes</span>
            </div>
            
            {!audioUnlocked && (
              <button 
                onClick={unlockAudio}
                className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              >
                <Volume2 className="w-4 h-4" />
                Habilitar áudio
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-4">
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 h-full">
          {/* Canvas Area */}
          <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 overflow-hidden">
            <div className="p-3 border-b border-gray-700/50">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-400">
                  Conexões: {diag.connected} | Áudio remoto: {diag.remoteAudio}
                </div>
                <div className="text-xs text-gray-500">
                  Use WASD para mover • Duplo clique para teleportar
                </div>
              </div>
            </div>
            <div className="relative">
              <canvas
                ref={canvasRef}
                width={800}
                height={500}
                onClick={handleCanvasClick}
                onDoubleClick={handleDblClick}
                className="w-full h-[50vh] lg:h-[60vh] bg-gray-900 cursor-crosshair"
              />
            </div>
          </div>

          {/* Sidebar */}
          <div className="flex flex-col gap-4">
            {/* Preview de Vídeo */}
            <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 overflow-hidden">
              <div className="p-3 border-b border-gray-700/50">
                <h3 className="text-white font-medium text-sm">Seu vídeo</h3>
              </div>
              <div className="relative aspect-video bg-gray-900">
                <video 
                  ref={localVideoRef} 
                  className="w-full h-full object-cover" 
                  muted 
                  playsInline 
                />
                {!camEnabled && (
                  <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
                    <div className="text-center">
                      <VideoOff className="w-8 h-8 text-gray-600 mx-auto mb-2" />
                      <p className="text-gray-500 text-sm">Câmera desligada</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Controles */}
            <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 p-4">
              <h3 className="text-white font-medium text-sm mb-4">Controles</h3>
              
              <div className="space-y-3">
                {/* Microfone */}
                <button
                  onClick={toggleMic}
                  className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                    micEnabled 
                      ? "bg-green-600/20 border-green-500 text-green-400 hover:bg-green-600/30" 
                      : "bg-gray-900/50 border-gray-600 text-gray-400 hover:bg-gray-800/50"
                  }`}
                >
                  {micEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                  <span className="font-medium">
                    {micEnabled ? "Microfone Ligado" : "Microfone Desligado"}
                  </span>
                </button>

                {/* Câmera */}
                <button
                  onClick={toggleCam}
                  className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                    camEnabled 
                      ? "bg-green-600/20 border-green-500 text-green-400 hover:bg-green-600/30" 
                      : "bg-gray-900/50 border-gray-600 text-gray-400 hover:bg-gray-800/50"
                  }`}
                >
                  {camEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                  <span className="font-medium">
                    {camEnabled ? "Câmera Ligada" : "Câmera Desligada"}
                  </span>
                </button>

              </div>
            </div>

            {/* Status da Conexão */}
            <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 p-4">
              <h3 className="text-white font-medium text-sm mb-3">Status</h3>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Conexões ativas:</span>
                  <span className="text-green-400 font-medium">{diag.connected}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Áudio remoto:</span>
                  <span className="text-blue-400 font-medium">{diag.remoteAudio}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Participantes:</span>
                  <span className="text-purple-400 font-medium">{peersCount + 1}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Hidden container for remote audio */}
      <div ref={remoteContainerRef} className="hidden" />
    </div>
  );
}


