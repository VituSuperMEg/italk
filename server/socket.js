const { createServer } = require("http");
const { Server } = require("socket.io");

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

io.on("connection", (socket) => {
  socket.on("join", ({ roomId, displayName }) => {
    socket.data.displayName = displayName;
    socket.join(roomId);
    socket.to(roomId).emit("peer-joined", { id: socket.id, displayName });

    const peers = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
      .filter((id) => id !== socket.id)
      .map((id) => {
        const s = io.sockets.sockets.get(id);
        return { id, displayName: s?.data?.displayName || "" };
      });
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

  socket.on("disconnecting", () => {
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


