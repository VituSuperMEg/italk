const { createServer } = require("http");
const { Server } = require("socket.io");

const httpServer = createServer((req, res) => {
  if (req.url === "/" || req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  // For any other path (like /socket.io), do NOT write a response here.
  // Let Socket.IO handle the request to ensure proper CORS headers.
});
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false,
  },
  transports: ["websocket", "polling"],
});

io.on("connection", (socket) => {
  console.log(`[socket] client connected: ${socket.id}`);
  socket.on("join", ({ roomId, displayName }) => {
    console.log(`[server] client ${socket.id} joining room ${roomId} as ${displayName}`);
    socket.data.displayName = displayName;
    socket.join(roomId);
    socket.to(roomId).emit("peer-joined", { id: socket.id, displayName });

    const peers = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
      .filter((id) => id !== socket.id)
      .map((id) => {
        const s = io.sockets.sockets.get(id);
        return { id, displayName: s?.data?.displayName || "" };
      });
    console.log(`[server] sending peers list to ${socket.id}:`, peers);
    socket.emit("peers", peers);
  });

  socket.on("signal", ({ targetId, data }) => {
    socket.to(targetId).emit("signal", { from: socket.id, data });
  });

  // simple position relay for proximity features
  socket.on("pos-update", ({ roomId, x, y }) => {
    // broadcast to others in the same room
    socket.to(roomId).emit("peer-pos", { id: socket.id, x, y });
  });

  // Chat message relay
  socket.on("chat-message", ({ roomId, message, from }) => {
    console.log(`[server] chat message from ${socket.id} in room ${roomId}: ${message}`);
    // broadcast to all others in the same room
    socket.to(roomId).emit("chat-message", { 
      from, 
      message, 
      timestamp: Date.now() 
    });
  });

  // Private message relay
  socket.on("private-message", ({ roomId, targetId, message, from }) => {
    console.log(`[server] private message from ${socket.id} to ${targetId}: ${message}`);
    // send to specific target user
    socket.to(targetId).emit("private-message", { 
      from, 
      message, 
      timestamp: Date.now(),
      fromId: socket.id
    });
  });

  socket.on("disconnecting", () => {
    console.log(`[socket] client disconnecting: ${socket.id}`);
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      socket.to(roomId).emit("peer-left", { id: socket.id });
    }
  });
});

const port = process.env.PORT ? Number(process.env.PORT) : (process.env.SIGNAL_PORT ? Number(process.env.SIGNAL_PORT) : 4001);
httpServer.listen(port, () => {
  console.log(`[socket] signaling server listening on ${port}`);
});


