const io = require('socket.io-client');
const socket = io('http://localhost:6060');

socket.on('connect', () => {
  console.log('Connected to WebSocket server');
  socket.emit('event', { key: 'value' });
});

socket.on('response', (data) => {
  console.log('Server response:', data);
});
