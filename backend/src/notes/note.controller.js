import * as noteService from "./note.service.js";
import pool from "../config/db.js";
import { employeeOf } from "../shared/scope.js";
import {
  readScope, isHrRecordUser, parseEmployeeId, managesEmployee,
} from "../shared/employeeAccess.js";

// An HR note on a personnel record is HR data. The service now refuses a
// cross-tenant employee, but nothing stopped a same-company `employee` role
// from writing notes onto a colleague's record — verified live on 2026-09-30,
// a plain employee POSTed a note against employee 1 and got a 201.
//
// READS (2026-10-20). They used to be open to any authenticated caller in the
// tenant "matching the rest of the profile page" — so an ordinary employee
// could read HR's notes about any colleague. hr_notes has no visibility or
// confidentiality column: nothing marks a note as meant for the employee, or as
// shareable with a manager. With no such marker every note is treated as a
// confidential HR note, and only the HR seats (HR_RECORD_ROLES in
// shared/employeeAccess.js) may read them. The employee themselves, managers and
// department heads get 403 — including a department head who wrote the note,
// since authorship is not a confidentiality rule. Making some notes visible to
// the employee or the line manager needs a visibility column first.
const NOTE_WRITE_ROLES = new Set([
  'admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'department_head',
]);

function canWriteNotes(req) {
  const roles = [req.user?.role, ...(req.user?.roles || [])]
    .filter(Boolean)
    .map(r => String(r).toLowerCase());
  return roles.some(r => NOTE_WRITE_ROLES.has(r));
}

function fail(res, err) {
  const status = err?.statusCode ?? 500;
  // Below 500 the message is the product's own wording and is safe to show;
  // a 500 is a server fault and its text is for the log, not the user.
  return res
    .status(status)
    .json({ message: status < 500 ? err.message : 'Could not complete the request' });
}

export const createNote = async (req, res) => {
  try {
    if (!canWriteNotes(req)) {
      return res.status(403).json({ message: 'Only HR can add notes to an employee record' });
    }
    const scope = readScope(req);
    if (scope.refused) return res.status(403).json({ message: 'Your account has no company assignment' });
    const { employeeId, noteText } = req.body;
    // A department head who holds no HR seat writes only onto the record of
    // someone they currently manage (2026-10-20): managesEmployee() — the
    // reporting line by id, or the current head of the employee's department,
    // inside the caller's own company (never a client-supplied one). Unrelated
    // and other-company targets get the same 403, so the answer does not reveal
    // whether the id exists. HR seats keep company-wide writes.
    if (!isHrRecordUser(req)) {
      const target = parseEmployeeId(employeeId);
      if (target == null) return res.status(400).json({ message: 'A valid employeeId is required' });
      const me = await employeeOf(req, pool);
      if (!await managesEmployee({ managerEmployeeId: me, employeeId: target, companyId: scope.companyId })) {
        return res.status(403).json({ message: 'You can add notes only for employees you manage' });
      }
    }
    const note = await noteService.addNote(employeeId, noteText, {
      companyId: scope.companyId,
      userId: req.user?.userId ?? req.user?.id ?? null,
    });
    res.status(201).json(note);
  } catch (err) {
    if (!err?.statusCode) console.error('[notes] create failed:', err.message);
    fail(res, err);
  }
};

export const getEmployeeNotes = async (req, res) => {
  try {
    // Role first, before the id is even looked at, so a refused caller learns
    // nothing about which employees exist or have notes.
    if (!isHrRecordUser(req)) {
      return res.status(403).json({ message: 'HR notes are visible to HR only' });
    }
    const scope = readScope(req);
    if (scope.refused) return res.status(403).json({ message: 'Your account has no company assignment' });
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (employeeId == null) return res.status(400).json({ message: 'A valid employeeId is required' });
    const notes = await noteService.getNotesByEmployee(employeeId, { companyId: scope.companyId });
    res.json(notes);
  } catch (err) {
    if (!err?.statusCode) console.error('[notes] read failed:', err.message);
    fail(res, err);
  }
};
