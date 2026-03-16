import * as noteService from "./note.service.js";

export const createNote = async (req, res) => {
  try {
    const { employeeId, noteText } = req.body;
    const note = await noteService.addNote(employeeId, noteText);
    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getEmployeeNotes = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const notes = await noteService.getNotesByEmployee(employeeId);
    res.json(notes);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
