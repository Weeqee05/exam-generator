// Version 0.2 intentionally keeps reference answers on the server.
// A standalone HTML bundle cannot provide that property.
console.error('Новая версия требует сервер Node.js: ответы и решения хранятся на сервере.');
console.error('Запусти npm start и открой http://localhost:8000 на своём компьютере.');
console.error('downloads/praktikum.html и praktikum.zip — прежняя автономная версия 0.1 без нового ассистента.');
console.error('Для размещения текущей версии см. README.md и DEPLOY.md.');
process.exitCode = 1;
