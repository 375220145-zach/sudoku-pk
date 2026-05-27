const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ==================== 数独算法 ====================

function isValid(board, row, col, num) {
  for (let c = 0; c < 9; c++) if (board[row][c] === num) return false;
  for (let r = 0; r < 9; r++) if (board[r][col] === num) return false;
  const br = Math.floor(row / 3) * 3, bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++)
      if (board[r][c] === num) return false;
  return true;
}

function solve(board) {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (board[r][c] === 0) {
        for (let n = 1; n <= 9; n++) {
          if (isValid(board, r, c, n)) {
            board[r][c] = n;
            if (solve(board)) return true;
            board[r][c] = 0;
          }
        }
        return false;
      }
    }
  }
  return true;
}

function countSolutions(board, limit = 2) {
  let count = 0;
  const copy = board.map(r => [...r]);
  (function solveCount(b) {
    if (count >= limit) return;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (b[r][c] === 0) {
          for (let n = 1; n <= 9; n++) {
            if (isValid(b, r, c, n)) {
              b[r][c] = n;
              solveCount(b);
              b[r][c] = 0;
            }
          }
          return;
        }
      }
    }
    count++;
  })(copy);
  return count;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCompleteBoard() {
  const board = Array(9).fill(null).map(() => Array(9).fill(0));
  for (let box = 0; box < 3; box++) {
    const nums = shuffle([1,2,3,4,5,6,7,8,9]);
    let idx = 0;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        board[box*3+i][box*3+j] = nums[idx++];
  }
  solve(board);
  return board;
}

function createPuzzle(solution, difficulty) {
  const remove = { easy: 38, medium: 48, hard: 56 };
  const puzzle = solution.map(r => [...r]);
  const positions = shuffle(
    Array.from({length:81}, (_,i) => [Math.floor(i/9), i%9])
  );
  let removed = 0;
  for (const [r, c] of positions) {
    if (removed >= remove[difficulty]) break;
    const backup = puzzle[r][c];
    puzzle[r][c] = 0;
    if (difficulty !== 'easy' && countSolutions(puzzle, 2) > 1) {
      puzzle[r][c] = backup;
      continue;
    }
    removed++;
  }
  return puzzle;
}

function generateGame(difficulty) {
  const solution = generateCompleteBoard();
  const puzzle = createPuzzle(solution, difficulty);
  return { puzzle, solution };
}

function checkSolution(userBoard, solution) {
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      if (userBoard[r][c] !== solution[r][c]) return false;
  return true;
}

// ==================== 房间管理 ====================

const rooms = new Map();

function createRoomCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (rooms.has(code));
  return code;
}

function getRoomBySocket(socketId) {
  for (const [code, room] of rooms) {
    if (room.players.some(p => p.id === socketId)) return { code, room };
  }
  return null;
}

// ==================== Socket.IO ====================

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 创建房间
  socket.on('create-room', (data) => {
    const { difficulty } = data || {};
    const diff = difficulty || 'easy';
    const { puzzle, solution } = generateGame(diff);
    const roomCode = createRoomCode();

    rooms.set(roomCode, {
      code: roomCode,
      difficulty: diff,
      puzzle,
      solution,
      status: 'waiting', // waiting → ready → playing → finished
      players: [{ id: socket.id, role: 'creator', finished: false, time: 0, score: 0 }],
      createdAt: Date.now(),
    });

    socket.join(roomCode);
    socket.emit('room-created', { roomCode, difficulty: diff });
    console.log(`Room ${roomCode} created by ${socket.id}`);
  });

  // 加入房间
  socket.on('join-room', (data) => {
    const { roomCode } = data || {};
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('join-error', { message: '房间不存在' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('join-error', { message: '房间已满' });
      return;
    }
    if (room.status !== 'waiting') {
      socket.emit('join-error', { message: '游戏已开始' });
      return;
    }
    if (room.players[0].id === socket.id) {
      socket.emit('join-error', { message: '这是你自己创建的房间，请分享链接给朋友' });
      return;
    }

    room.players.push({ id: socket.id, role: 'joiner', finished: false, time: 0, score: 0 });
    room.status = 'ready';
    socket.join(roomCode);

    // 通知双方
    socket.emit('join-success', { roomCode, difficulty: room.difficulty });
    io.to(roomCode).emit('opponent-joined', { playerCount: room.players.length });
    console.log(`Player ${socket.id} joined room ${roomCode}`);
  });

  // 房主开始游戏
  socket.on('start-game', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    if (room.players[0].id !== socket.id) return;
    if (room.status !== 'ready') return;

    room.status = 'playing';
    room.startedAt = Date.now();

    io.to(code).emit('game-start', {
      puzzle: room.puzzle,
      difficulty: room.difficulty,
      startTime: room.startedAt,
    });
    console.log(`Game started in room ${code}`);
  });

  // 提交答案
  socket.on('submit-answer', (data) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    if (room.status !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.finished) return;

    const { board, time } = data;
    const correct = checkSolution(board, room.solution);

    if (!correct) {
      socket.emit('submit-result', { correct: false, message: '答案有误' });
      return;
    }

    player.finished = true;
    player.time = time;

    // 计分
    const finishedCount = room.players.filter(p => p.finished).length;
    player.score = finishedCount === 1 ? 3 : 1;

    socket.emit('submit-result', {
      correct: true,
      score: player.score,
      rank: finishedCount,
      time,
    });

    // 通知对手
    socket.to(code).emit('opponent-finished', {
      opponentTime: time,
      opponentScore: player.score,
    });

    // 检查是否全部完成
    if (room.players.every(p => p.finished)) {
      room.status = 'finished';
      io.to(code).emit('game-over', {
        players: room.players.map(p => ({
          role: p.role,
          score: p.score,
          time: p.time,
          finished: p.finished,
        })),
      });
    }

    console.log(`Player ${socket.id} submitted in room ${code}, score: ${player.score}`);
  });

  // 对手状态查询
  socket.on('check-opponent', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const opponent = result.room.players.find(p => p.id !== socket.id);
    if (opponent && opponent.finished) {
      socket.emit('opponent-status', { finished: true, time: opponent.time });
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

// 定期清理超过 1 小时的房间
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 3600000) rooms.delete(code);
  }
}, 600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sudoku PK server running at http://localhost:${PORT}`);
});
