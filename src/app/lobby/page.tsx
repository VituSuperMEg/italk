"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, MicOff, Video, VideoOff, User, LogIn } from "lucide-react";

export default function LobbyPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [enableMic, setEnableMic] = useState(false);
  const [enableCam, setEnableCam] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [skipCamera, setSkipCamera] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: NodeJS.Timeout;
    
    async function setupPreview() {
      try {
        // Limpa o stream anterior completamente
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => {
            t.stop();
            t.enabled = false;
          });
          streamRef.current = null;
        }
        
        // Limpa o vídeo
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
        
        setCameraError(false);

        // Se ambos estão desligados ou se deve pular a câmera, apenas retorna
        if ((!enableMic && !enableCam) || skipCamera) {
          return;
        }

        // Verifica se getUserMedia está disponível
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          console.warn("getUserMedia não está disponível neste navegador");
          setCameraError(true);
          return;
        }

        // Verifica se está em HTTPS (necessário para acessar câmera em produção)
        if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
          console.warn("Acesso à câmera requer HTTPS em produção");
          setCameraError(true);
          return;
        }

        // Aguarda um pouco antes de tentar acessar a câmera
        await new Promise(resolve => setTimeout(resolve, 200));

        // Adiciona um timeout mais curto
        timeoutId = setTimeout(() => {
          if (!cancelled) {
            console.warn("Timeout ao acessar dispositivos");
            setCameraError(true);
          }
        }, 5000); // 5 segundos de timeout

        // Tenta acessar apenas áudio primeiro se necessário
        let stream: MediaStream;
        
        if (enableMic && !enableCam) {
          // Só áudio
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
        } else if (enableCam && !enableMic) {
          // Só vídeo
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true,
          });
        } else {
          // Ambos
          stream = await navigator.mediaDevices.getUserMedia({
            audio: enableMic,
            video: enableCam,
          });
        }
        
        clearTimeout(timeoutId);
        
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        stream.getAudioTracks().forEach((t) => (t.enabled = enableMic));
        stream.getVideoTracks().forEach((t) => (t.enabled = enableCam));
      } catch (e: unknown) {
        clearTimeout(timeoutId);
        console.warn("Não foi possível acessar dispositivos:", e);
        setCameraError(true);
        // Limpa o stream em caso de erro
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
      }
    }
    
    // Adiciona um delay maior para evitar conflitos
    const delayId = setTimeout(setupPreview, 300);
    
    return () => {
      cancelled = true;
      clearTimeout(delayId);
      clearTimeout(timeoutId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [enableMic, enableCam, skipCamera]);

  const canJoin = useMemo(() => displayName.trim().length >= 2, [displayName]);

  function handleJoin() {
    const roomId = "general"; 
    const params = new URLSearchParams({
      name: displayName.trim(),
      mic: String(enableMic),
      cam: String(skipCamera ? false : enableCam),
    });
    router.push(`/room/${roomId}?${params.toString()}`);
  }

  function handleCameraToggle() {
    setEnableCam((v) => !v);
    // Limpa o erro e reset do skip quando o usuário tenta novamente
    if (cameraError || skipCamera) {
      setCameraError(false);
      setSkipCamera(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo e Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">iTalk</h1>
          <p className="text-gray-400 text-sm">Conecte-se com o mundo</p>
        </div>

        {/* Card Principal */}
        <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700/50 p-6 shadow-2xl">
          {/* Campo de Nome */}
          <div className="mb-6">
            <label className="flex items-center gap-2 text-gray-300 text-sm font-medium mb-3">
              <User className="w-4 h-4" />
              Seu nome
            </label>
            <input
              className="w-full bg-gray-900/50 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              placeholder="Ex: Ana Silva"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {/* Controles de Dispositivos */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <button
              className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                enableMic 
                  ? "bg-green-600/20 border-green-500 text-green-400 hover:bg-green-600/30" 
                  : "bg-gray-900/50 border-gray-600 text-gray-400 hover:bg-gray-800/50"
              }`}
              onClick={() => setEnableMic((v) => !v)}
            >
              {enableMic ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
              <span className="text-sm font-medium">
                {enableMic ? "Ligado" : "Desligado"}
              </span>
            </button>
            
            <button
              className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                enableCam 
                  ? "bg-green-600/20 border-green-500 text-green-400 hover:bg-green-600/30" 
                  : "bg-gray-900/50 border-gray-600 text-gray-400 hover:bg-gray-800/50"
              }`}
              onClick={handleCameraToggle}
            >
              {enableCam ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
              <span className="text-sm font-medium">
                {enableCam ? "Ligado" : "Desligado"}
              </span>
            </button>
          </div>

          {/* Preview de Vídeo */}
          <div className="mb-6">
            <div className="relative rounded-xl overflow-hidden border border-gray-600 aspect-video bg-gray-900 flex items-center justify-center">
              <video 
                ref={videoRef} 
                className="w-full h-full object-cover" 
                muted 
                playsInline 
                autoPlay
              />
              {(!enableCam || cameraError || skipCamera) && (
                <div className="absolute inset-0 bg-gray-900 flex items-center justify-center z-10">
                  <div className="text-center">
                    <VideoOff className="w-12 h-12 text-gray-600 mx-auto mb-2" />
                    <p className="text-gray-500 text-sm">
                      {skipCamera ? "Câmera desabilitada" : cameraError ? "Erro ao acessar câmera" : "Câmera desligada"}
                    </p>
                    {cameraError && !skipCamera && (
                      <div className="mt-2">
                        <p className="text-gray-400 text-xs mb-2">
                          Verifique as permissões do navegador
                        </p>
                        <button
                          onClick={() => setSkipCamera(true)}
                          className="text-blue-400 text-xs hover:text-blue-300 underline"
                        >
                          Continuar sem câmera
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Botão de Entrar */}
          <button
            disabled={!canJoin}
            onClick={handleJoin}
            className={`w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-medium transition-all ${
              canJoin
                ? "bg-white text-gray-900 hover:bg-gray-100 shadow-lg hover:shadow-xl transform hover:scale-[1.02]"
                : "bg-gray-700 text-gray-500 cursor-not-allowed"
            }`}
          >
            <LogIn className="w-5 h-5" />
            Entrar na sala
          </button>
        </div>

        {/* Footer */}
        <div className="text-center mt-6">
          <p className="text-gray-500 text-xs">
            Configure seus dispositivos antes de entrar
          </p>
        </div>
      </div>
    </div>
  );
}


