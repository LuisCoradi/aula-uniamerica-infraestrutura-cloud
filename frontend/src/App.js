import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

// O endereco da API vem do build, nunca fica chumbado no codigo.
// Definido em .env.production como https://api.trabaidafacul.site
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

function App() {
  const [todos, setTodos] = useState([]);
  const [task, setTask] = useState("");
  const [erro, setErro] = useState(null);

  // Função para carregar os todos da API
  const fetchTodos = async () => {
    try {
      const response = await axios.get(`${API_URL}/todos`);
      setTodos(response.data);
      setErro(null);
    } catch (e) {
      setErro('Nao foi possivel carregar as tarefas.');
    }
  };

  // Função para adicionar uma nova tarefa
  const addTodo = async () => {
    if (task.trim()) {
      const response = await axios.post(`${API_URL}/todos`, { text: task });
      setTodos([...todos, response.data]);
      setTask("");
    }
  };

  // Função para marcar a tarefa como concluída
  const toggleComplete = async (id) => {
    const response = await axios.patch(`${API_URL}/todos/${id}`);
    const updatedTodos = todos.map(todo =>
      todo._id === id ? response.data : todo
    );
    setTodos(updatedTodos);
  };

  // Função para excluir a tarefa
  const deleteTodo = async (id) => {
    await axios.delete(`${API_URL}/todos/${id}`);
    setTodos(todos.filter(todo => todo._id !== id));
  };

  // Carregar a lista de todos ao iniciar o componente
  useEffect(() => {
    fetchTodos();
  }, []);

  return (
    <div className="App">
      <h1>Lista de Tarefas</h1>
      {erro && <p style={{ color: 'crimson' }}>{erro}</p>}
      <div>
        <input
          type="text"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Adicione uma tarefa"
        />
        <button onClick={addTodo}>Adicionar</button>
      </div>
      <ul>
        {todos.map((todo) => (
          <li key={todo._id} style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
            <span onClick={() => toggleComplete(todo._id)}>{todo.text}</span>
            <button onClick={() => deleteTodo(todo._id)}>Excluir</button>
          </li>
        ))}
      </ul>
      <footer style={{ marginTop: 32, fontSize: 12, opacity: 0.6 }}>
        API: {API_URL}
      </footer>
    </div>
  );
}

export default App;
