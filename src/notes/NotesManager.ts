import * as fs from 'fs';
import * as path from 'path';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  todos: TodoItem[];
  createdAt: number;
  updatedAt: number;
}

export class NotesManager {
  private notes: Note[] = [];
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'notes.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.notes = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Note[];
    } catch { /* corrupt — start fresh */ }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.notes, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  private makeId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  getAll(): Note[] {
    return JSON.parse(JSON.stringify(this.notes));
  }

  get(id: string): Note | undefined {
    return this.notes.find(n => n.id === id);
  }

  add(title: string, body: string): Note {
    const now = Date.now();
    const note: Note = {
      id: this.makeId(),
      title: title.trim() || 'Untitled',
      body,
      todos: [],
      createdAt: now,
      updatedAt: now,
    };
    this.notes.unshift(note);
    this.save();
    return note;
  }

  update(id: string, patch: Partial<Pick<Note, 'title' | 'body'>>): boolean {
    const note = this.notes.find(n => n.id === id);
    if (!note) return false;
    if (patch.title !== undefined) note.title = patch.title.trim() || 'Untitled';
    if (patch.body  !== undefined) note.body  = patch.body;
    note.updatedAt = Date.now();
    this.save();
    return true;
  }

  remove(id: string): void {
    this.notes = this.notes.filter(n => n.id !== id);
    this.save();
  }

  addTodo(noteId: string, text: string): TodoItem | undefined {
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return undefined;
    const todo: TodoItem = { id: this.makeId(), text: text.trim(), done: false, createdAt: Date.now() };
    note.todos.push(todo);
    note.updatedAt = Date.now();
    this.save();
    return todo;
  }

  toggleTodo(noteId: string, todoId: string): boolean {
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return false;
    const todo = note.todos.find(t => t.id === todoId);
    if (!todo) return false;
    todo.done = !todo.done;
    note.updatedAt = Date.now();
    this.save();
    return true;
  }

  removeTodo(noteId: string, todoId: string): void {
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return;
    note.todos = note.todos.filter(t => t.id !== todoId);
    note.updatedAt = Date.now();
    this.save();
  }

  editTodo(noteId: string, todoId: string, text: string): boolean {
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return false;
    const todo = note.todos.find(t => t.id === todoId);
    if (!todo) return false;
    todo.text = text.trim();
    note.updatedAt = Date.now();
    this.save();
    return true;
  }

  setTodosFromAgent(noteId: string, todos: string[]): boolean {
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return false;
    const now = Date.now();
    note.todos = todos.map(t => ({ id: this.makeId(), text: t.trim(), done: false, createdAt: now }));
    note.updatedAt = now;
    this.save();
    return true;
  }
}
