import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server, Socket } from "socket.io";
import { v4 as uuidv4 } from "uuid";

// Create HTTP server with health check endpoint
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://omegle-drab.vercel.app",
      "https://directconnectwithgod.vercel.app",
      /\.vercel\.app$/,
    ],
    methods: ["GET", "POST"],
  },
});

interface User {
  id: string;
  socketId: string;
  interests?: string[];
  inChat: boolean;
  partnerId?: string;
}

interface Message {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
}

const waitingUsers: User[] = [];
const activeUsers: Map<string, User> = new Map();

function findPartner(user: User): User | null {
  // First, try to find someone with matching interests
  if (user.interests && user.interests.length > 0) {
    for (let i = 0; i < waitingUsers.length; i++) {
      const potentialPartner = waitingUsers[i];
      if (potentialPartner.id !== user.id && potentialPartner.interests) {
        const commonInterests = user.interests.filter((interest) =>
          potentialPartner.interests?.includes(interest)
        );
        if (commonInterests.length > 0) {
          return waitingUsers.splice(i, 1)[0];
        }
      }
    }
  }

  // If no matching interests, find any available user
  for (let i = 0; i < waitingUsers.length; i++) {
    if (waitingUsers[i].id !== user.id) {
      return waitingUsers.splice(i, 1)[0];
    }
  }

  return null;
}

function removeFromWaiting(userId: string): void {
  const index = waitingUsers.findIndex((u) => u.id === userId);
  if (index !== -1) {
    waitingUsers.splice(index, 1);
  }
}

io.on("connection", (socket: Socket) => {
  console.log(`User connected: ${socket.id}`);

  const userId = uuidv4();
  const user: User = {
    id: userId,
    socketId: socket.id,
    inChat: false,
  };
  activeUsers.set(socket.id, user);

  socket.emit("user-id", userId);
  socket.emit("online-count", activeUsers.size);

  // Broadcast online count to all users
  io.emit("online-count", activeUsers.size);

  socket.on("find-partner", (interests?: string[]) => {
    const currentUser = activeUsers.get(socket.id);
    if (!currentUser) return;

    // Remove from waiting if already there
    removeFromWaiting(currentUser.id);

    currentUser.interests = interests;
    currentUser.inChat = false;

    const partner = findPartner(currentUser);

    if (partner) {
      // Match found
      currentUser.partnerId = partner.id;
      currentUser.inChat = true;
      partner.partnerId = currentUser.id;
      partner.inChat = true;

      const partnerSocket = io.sockets.sockets.get(partner.socketId);

      // Create a room for the pair
      const roomId = `room-${currentUser.id}-${partner.id}`;

      socket.join(roomId);
      partnerSocket?.join(roomId);

      // Determine who initiates the call (the user who just connected)
      socket.emit("partner-found", {
        partnerId: partner.id,
        roomId,
        initiator: true,
      });

      partnerSocket?.emit("partner-found", {
        partnerId: currentUser.id,
        roomId,
        initiator: false,
      });

      console.log(`Matched users: ${currentUser.id} and ${partner.id}`);
    } else {
      // Add to waiting queue
      waitingUsers.push(currentUser);
      socket.emit("waiting");
      console.log(`User ${currentUser.id} added to waiting queue. Queue size: ${waitingUsers.length}`);
    }
  });

  socket.on("cancel-search", () => {
    const currentUser = activeUsers.get(socket.id);
    if (currentUser) {
      removeFromWaiting(currentUser.id);
      socket.emit("search-cancelled");
    }
  });

  socket.on("webrtc-signal", ({ signal, roomId }) => {
    socket.to(roomId).emit("webrtc-signal", { signal, from: socket.id });
  });

  socket.on("send-message", ({ message, roomId }) => {
    const currentUser = activeUsers.get(socket.id);
    if (!currentUser) return;

    const msgData: Message = {
      id: uuidv4(),
      senderId: currentUser.id,
      content: message,
      timestamp: new Date(),
    };

    io.to(roomId).emit("receive-message", msgData);
  });

  socket.on("typing", ({ roomId, isTyping }) => {
    socket.to(roomId).emit("partner-typing", isTyping);
  });

  // Game request/accept/decline handlers
  socket.on("request-game", ({ roomId, gameType }) => {
    socket.to(roomId).emit("game-request", { gameType });
    console.log(`Game request sent in room ${roomId}: ${gameType}`);
  });

  socket.on("accept-game", ({ roomId, gameType }) => {
    socket.to(roomId).emit("game-accepted", { gameType });
    console.log(`Game accepted in room ${roomId}: ${gameType}`);
  });

  socket.on("decline-game", ({ roomId, gameType }) => {
    socket.to(roomId).emit("game-declined", { gameType });
    console.log(`Game declined in room ${roomId}: ${gameType}`);
  });

  socket.on("start-game", ({ roomId, gameType }) => {
    socket.to(roomId).emit("game-started", { gameType });
    console.log(`Game started in room ${roomId}: ${gameType}`);
  });

  // Tic Tac Toe move handler
  socket.on("tic-tac-toe-move", ({ roomId, index, symbol }) => {
    socket.to(roomId).emit("tic-tac-toe-move", { index, symbol });
  });

  // Tic Tac Toe play again handler
  socket.on("tic-tac-toe-play-again", ({ roomId }) => {
    socket.to(roomId).emit("tic-tac-toe-play-again");
  });

  // Would You Rather choice handler
  socket.on("wyr-choice", ({ roomId, choice }) => {
    socket.to(roomId).emit("wyr-choice", { choice });
  });

  // Would You Rather next question handler
  socket.on("wyr-next-question", ({ roomId, question }) => {
    socket.to(roomId).emit("wyr-next-question", { question });
  });

  socket.on("skip-partner", () => {
    const currentUser = activeUsers.get(socket.id);
    if (!currentUser || !currentUser.partnerId) return;

    // Find partner and notify them
    const partnerEntry = Array.from(activeUsers.entries()).find(
      ([, u]) => u.id === currentUser.partnerId
    );

    if (partnerEntry) {
      const [partnerSocketId, partner] = partnerEntry;
      const partnerSocket = io.sockets.sockets.get(partnerSocketId);

      partner.partnerId = undefined;
      partner.inChat = false;

      partnerSocket?.emit("partner-disconnected");
    }

    currentUser.partnerId = undefined;
    currentUser.inChat = false;

    socket.emit("chat-ended");
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    const currentUser = activeUsers.get(socket.id);
    if (currentUser) {
      // Notify partner if in chat
      if (currentUser.partnerId) {
        const partnerEntry = Array.from(activeUsers.entries()).find(
          ([, u]) => u.id === currentUser.partnerId
        );

        if (partnerEntry) {
          const [partnerSocketId, partner] = partnerEntry;
          const partnerSocket = io.sockets.sockets.get(partnerSocketId);
          partner.partnerId = undefined;
          partner.inChat = false;
          partnerSocket?.emit("partner-disconnected");
        }
      }

      removeFromWaiting(currentUser.id);
      activeUsers.delete(socket.id);
    }

    // Broadcast updated online count
    io.emit("online-count", activeUsers.size);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
