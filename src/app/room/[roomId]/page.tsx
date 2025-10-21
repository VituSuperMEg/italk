"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { Mic, MicOff, Video, VideoOff, Users, Volume2, MessageCircle, Send, X } from "lucide-react";

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
  
  // Chat states
  const [messages, setMessages] = useState<Array<{
    id: string;
    from: string;
    fromId: string;
    message: string;
    timestamp: number;
  }>>([]);
  const [newMessage, setNewMessage] = useState("");
  const [showChat, setShowChat] = useState(false);
  
  // Private chat states
  const [privateMessages, setPrivateMessages] = useState<Map<string, Array<{
    id: string;
    from: string;
    fromId: string;
    message: string;
    timestamp: number;
  }>>>(new Map());
  const [showPrivateChat, setShowPrivateChat] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<Peer | null>(null);
  const [newPrivateMessage, setNewPrivateMessage] = useState("");
  const [unreadGeneralMessages, setUnreadGeneralMessages] = useState(0);
  const [unreadPrivateCounts, setUnreadPrivateCounts] = useState<Map<string, number>>(new Map());

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

    // Chat messages
    socket.on("chat-message", ({ from, message, timestamp }: { from: string; message: string; timestamp: number }) => {
      const chatMessage = {
        id: `${from}-${timestamp}`,
        from,
        fromId: "peer",
        message,
        timestamp
      };
      setMessages(prev => [...prev, chatMessage]);
      
      // Incrementar contador de mensagens não lidas se o chat não estiver aberto
      if (!showChat) {
        setUnreadGeneralMessages(prev => prev + 1);
      }
    });

    // Private messages
    socket.on("private-message", ({ from, message, timestamp, fromId }: { from: string; message: string; timestamp: number; fromId: string }) => {
      const privateMessage = {
        id: `${fromId}-${timestamp}`,
        from,
        fromId: "peer",
        message,
        timestamp
      };
      
      setPrivateMessages(prev => {
        const newMap = new Map(prev);
        const existingMessages = newMap.get(fromId) || [];
        newMap.set(fromId, [...existingMessages, privateMessage]);
        return newMap;
      });
      
      // Notificação já é gerenciada pelo contador abaixo
      
      // Incrementar contador específico para este peer
      setUnreadPrivateCounts(prev => {
        const newMap = new Map(prev);
        const currentCount = newMap.get(fromId) || 0;
        newMap.set(fromId, currentCount + 1);
        return newMap;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [roomId, displayName, readyToCall, createPeer, showChat]);

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
        if (!showChat) {
          if (keys["w"]) y -= speed;
          if (keys["s"]) y += speed;
          if (keys["a"]) x -= speed;
          if (keys["d"]) x += speed;
        }
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
  }, [keys, pos.x, pos.y, userEmoji, peerEmojis, peers, displayName, showChat]);

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

  // Chat functions
  function sendMessage() {
    if (!newMessage.trim() || !socketRef.current) return;
    
    const message = {
      id: Date.now().toString(),
      from: displayName || "Você",
      fromId: "me",
      message: newMessage.trim(),
      timestamp: Date.now()
    };
    
    setMessages(prev => [...prev, message]);
    socketRef.current.emit("chat-message", {
      roomId,
      message: newMessage.trim(),
      from: displayName || "Você"
    });
    setNewMessage("");
  }

  function handleKeyPress(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // Private chat functions
  function openPrivateChat(peer: Peer) {
    setSelectedPeer(peer);
    setShowPrivateChat(true);
    // Marcar mensagens como lidas (contador já é limpo abaixo)
    // Limpar contador de mensagens não lidas para este peer
    setUnreadPrivateCounts(prev => {
      const newMap = new Map(prev);
      newMap.delete(peer.id);
      return newMap;
    });
  }

  function sendPrivateMessage() {
    if (!newPrivateMessage.trim() || !socketRef.current || !selectedPeer) return;
    
    const message = {
      id: Date.now().toString(),
      from: displayName || "Você",
      fromId: "me",
      message: newPrivateMessage.trim(),
      timestamp: Date.now()
    };
    
    // Adicionar mensagem ao chat privado
    const peerId = selectedPeer.id;
    setPrivateMessages(prev => {
      const newMap = new Map(prev);
      const existingMessages = newMap.get(peerId) || [];
      newMap.set(peerId, [...existingMessages, message]);
      return newMap;
    });
    
    socketRef.current.emit("private-message", {
      roomId,
      targetId: selectedPeer.id,
      message: newPrivateMessage.trim(),
      from: displayName || "Você"
    });
    setNewPrivateMessage("");
  }

  function handlePrivateKeyPress(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrivateMessage();
    }
  }


  const peersCount = useMemo(() => peers.length, [peers]);

  return (
    <div className="absolute inset-0 min-h-screen w-full bg-gradient-to-br from-gray-900 via-black to-gray-800 full-screen-bg">
      {/* Header */}
      <div className="relative z-10 bg-gray-800/50 backdrop-blur-sm border-b border-gray-700/50">
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
            
            <button 
              onClick={() => {
                setShowChat(!showChat);
                if (!showChat) {
                  setUnreadGeneralMessages(0);
                }
              }}
              className="relative z-20 flex items-center gap-2 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
            >
              <MessageCircle className="w-4 h-4" />
              Chat
              {unreadGeneralMessages > 0 && (
                <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-xs font-bold">
                  {unreadGeneralMessages > 99 ? '99+' : unreadGeneralMessages}
                </div>
              )}
            </button>
            
            {!audioUnlocked && (
              <button 
                onClick={unlockAudio}
                className="relative z-20 flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              >
                <Volume2 className="w-4 h-4" />
                Habilitar áudio
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="relative z-10 flex-1 p-4 flex flex-col">
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 flex-1">
          {/* Canvas Area */}
          <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 overflow-hidden h-[90vh]">
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
                className="w-full h-[90vh] bg-gray-900 cursor-crosshair relative z-0"
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

            {/* Participantes na Sala */}
            <div className="bg-gray-800/30 backdrop-blur-sm rounded-2xl border border-gray-700/50 p-4">
              <h3 className="text-white font-medium text-sm mb-3">Participantes na Sala</h3>
              <div className="space-y-2">
                {/* Você mesmo */}
                <div className="flex items-center gap-3 p-2 bg-gray-700/30 rounded-lg">
                  <div className="text-2xl">{userEmoji}</div>
                  <div className="flex-1">
                    <div className="text-white text-sm font-medium">{displayName || "Você"}</div>
                    <div className="text-gray-400 text-xs">Você</div>
                  </div>
                  <div className="flex items-center gap-1">
                    {micEnabled && <Mic className="w-3 h-3 text-green-400" />}
                    {camEnabled && <Video className="w-3 h-3 text-green-400" />}
                  </div>
                </div>
                
                {/* Outros participantes */}
                {peers.map((peer) => {
                  const emoji = peerEmojis.get(peer.id);
                  return (
                    <div key={peer.id} className="flex items-center gap-3 p-2 bg-gray-700/30 rounded-lg">
                      <div className="text-2xl">{emoji}</div>
                      <div className="flex-1">
                        <div className="text-white text-sm font-medium">{peer.displayName}</div>
                        <div className="text-gray-400 text-xs">Participante</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openPrivateChat(peer)}
                          className="relative p-1 text-gray-400 hover:text-blue-400 transition-colors"
                          title="Enviar mensagem privada"
                        >
                          <MessageCircle className="w-4 h-4" />
                          {unreadPrivateCounts.has(peer.id) && unreadPrivateCounts.get(peer.id)! > 0 && (
                            <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-xs font-bold text-white">
                              {unreadPrivateCounts.get(peer.id)! > 99 ? '99+' : unreadPrivateCounts.get(peer.id)}
                            </div>
                          )}
                        </button>
                        <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                      </div>
                    </div>
                  );
                })}
                
                {peers.length === 0 && (
                  <div className="text-center py-4">
                    <div className="text-gray-500 text-sm">Apenas você na sala</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Chat Panel */}
      {showChat && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-2xl border border-gray-700/50 w-full max-w-md h-[600px] flex flex-col">
            {/* Chat Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700/50">
              <h3 className="text-white font-medium">Chat da Sala</h3>
              <button 
                onClick={() => setShowChat(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (
                <div className="text-center text-gray-500 py-8">
                  <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>Nenhuma mensagem ainda</p>
                  <p className="text-sm">Seja o primeiro a enviar uma mensagem!</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div 
                    key={msg.id} 
                    className={`flex ${msg.fromId === "me" ? "justify-end" : "justify-start"}`}
                  >
                    <div className={`max-w-[80%] p-3 rounded-lg ${
                      msg.fromId === "me" 
                        ? "bg-blue-600 text-white" 
                        : "bg-gray-700 text-gray-100"
                    }`}>
                      {msg.fromId !== "me" && (
                        <div className="text-xs text-gray-300 mb-1">{msg.from}</div>
                      )}
                      <div className="text-sm">{msg.message}</div>
                      <div className={`text-xs mt-1 ${
                        msg.fromId === "me" ? "text-blue-200" : "text-gray-400"
                      }`}>
                        {new Date(msg.timestamp).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            {/* Message Input */}
            <div className="p-4 border-t border-gray-700/50">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Digite sua mensagem..."
                  className="flex-1 bg-gray-700 text-white placeholder-gray-400 px-3 py-2 rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={sendMessage}
                  disabled={!newMessage.trim()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Private Chat Panel */}
      {showPrivateChat && selectedPeer && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-2xl border border-gray-700/50 w-full max-w-md h-[600px] flex flex-col">
            {/* Private Chat Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700/50">
              <div className="flex items-center gap-3">
                <div className="text-2xl">{peerEmojis.get(selectedPeer.id)}</div>
                <div>
                  <h3 className="text-white font-medium">Chat com {selectedPeer.displayName}</h3>
                  <p className="text-gray-400 text-xs">Mensagem privada</p>
                </div>
              </div>
              <button 
                onClick={() => setShowPrivateChat(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Private Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {(!privateMessages.get(selectedPeer.id) || privateMessages.get(selectedPeer.id)?.length === 0) ? (
                <div className="text-center text-gray-500 py-8">
                  <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>Nenhuma mensagem privada ainda</p>
                  <p className="text-sm">Inicie uma conversa com {selectedPeer.displayName}!</p>
                </div>
              ) : (
                privateMessages.get(selectedPeer.id)?.map((msg) => (
                  <div 
                    key={msg.id} 
                    className={`flex ${msg.fromId === "me" ? "justify-end" : "justify-start"}`}
                  >
                    <div className={`max-w-[80%] p-3 rounded-lg ${
                      msg.fromId === "me" 
                        ? "bg-purple-600 text-white" 
                        : "bg-gray-700 text-gray-100"
                    }`}>
                      {msg.fromId !== "me" && (
                        <div className="text-xs text-gray-300 mb-1">{msg.from}</div>
                      )}
                      <div className="text-sm">{msg.message}</div>
                      <div className={`text-xs mt-1 ${
                        msg.fromId === "me" ? "text-purple-200" : "text-gray-400"
                      }`}>
                        {new Date(msg.timestamp).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            {/* Private Message Input */}
            <div className="p-4 border-t border-gray-700/50">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPrivateMessage}
                  onChange={(e) => setNewPrivateMessage(e.target.value)}
                  onKeyPress={handlePrivateKeyPress}
                  placeholder={`Mensagem para ${selectedPeer.displayName}...`}
                  className="flex-1 bg-gray-700 text-white placeholder-gray-400 px-3 py-2 rounded-lg border border-gray-600 focus:border-purple-500 focus:outline-none"
                />
                <button
                  onClick={sendPrivateMessage}
                  disabled={!newPrivateMessage.trim()}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hidden container for remote audio */}
      <div ref={remoteContainerRef} className="hidden" />
    </div>
  );
}


