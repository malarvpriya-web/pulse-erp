import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import './Tickets.css';

export default function Tickets() {
  const [tickets, setTickets] = useState([]);
  const [categories, setCategories] = useState([]);
  const [slaPolices, setSlaPolices] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [filters, setFilters] = useState({ status: '', priority: '' });
  const [formData, setFormData] = useState({
    subject: '',
    description: '',
    category_id: '',
    priority: 'Medium',
    requester_type: 'Employee',
    requester_name: '',
    requester_email: '',
    sla_policy_id: ''
  });

  useEffect(() => {
    fetchTickets();
    fetchCategories();
    fetchSLAPolicies();
  }, [filters]);

  const fetchTickets = async () => {
    try {
      const response = await api.get('/finance/tickets', { params: filters });
      setTickets(response.data);
    } catch (error) {
      console.error('Error fetching tickets:', error);
    }
  };

  const fetchCategories = async () => {
    try {
      const response = await api.get('/finance/ticket-categories');
      setCategories(response.data);
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  const fetchSLAPolicies = async () => {
    try {
      const response = await api.get('/finance/sla-policies');
      setSlaPolices(response.data);
    } catch (error) {
      console.error('Error fetching SLA policies:', error);
    }
  };

  const fetchTicketDetail = async (ticketId) => {
    try {
      const response = await api.get(`/finance/tickets/${ticketId}`);
      setSelectedTicket(response.data);
      setConversations(response.data.conversations || []);
      setShowDetail(true);
    } catch (error) {
      console.error('Error fetching ticket detail:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/finance/tickets', formData);
      alert('Ticket created successfully');
      setShowForm(false);
      fetchTickets();
      setFormData({
        subject: '',
        description: '',
        category_id: '',
        priority: 'Medium',
        requester_type: 'Employee',
        requester_name: '',
        requester_email: '',
        sla_policy_id: ''
      });
    } catch (error) {
      alert('Error creating ticket: ' + error.message);
    }
  };

  const handleStatusChange = async (ticketId, status) => {
    try {
      await api.put(`/finance/tickets/${ticketId}/status`, { status });
      alert('Status updated');
      fetchTickets();
      if (selectedTicket && selectedTicket.id === ticketId) {
        fetchTicketDetail(ticketId);
      }
    } catch (error) {
      alert('Error updating status: ' + error.message);
    }
  };

  const handleAddConversation = async () => {
    if (!newMessage.trim()) return;
    
    try {
      await api.post(`/finance/tickets/${selectedTicket.id}/conversations`, {
        message: newMessage,
        is_internal: false,
        created_by_name: localStorage.getItem('userName') || 'User'
      });
      setNewMessage('');
      fetchTicketDetail(selectedTicket.id);
    } catch (error) {
      alert('Error adding message: ' + error.message);
    }
  };

  const getPriorityColor = (priority) => {
    const colors = {
      'Low': '#10b981',
      'Medium': '#f59e0b',
      'High': '#ef4444',
      'Critical': '#dc2626'
    };
    return colors[priority] || '#6b7280';
  };

  const isOverdue = (ticket) => {
    if (ticket.status === 'Resolved' || ticket.status === 'Closed') return false;
    return new Date(ticket.resolution_due_at) < new Date();
  };

  return (
    <div className="tickets-page">
      <div className="page-header">
        <h1>Helpdesk Tickets</h1>
        <button className="primary-btn" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : 'Create Ticket'}
        </button>
      </div>

      {showForm && (
        <div className="ticket-form widget">
          <h2>New Ticket</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-row">
              <div className="form-group">
                <label>Subject *</label>
                <input type="text" value={formData.subject} onChange={(e) => setFormData({ ...formData, subject: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Category *</label>
                <select value={formData.category_id} onChange={(e) => setFormData({ ...formData, category_id: e.target.value })} required>
                  <option value="">-- Select Category --</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Priority *</label>
                <select value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: e.target.value })} required>
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                  <option value="Critical">Critical</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Description *</label>
              <textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} rows="4" required></textarea>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Requester Type *</label>
                <select value={formData.requester_type} onChange={(e) => setFormData({ ...formData, requester_type: e.target.value })} required>
                  <option value="Employee">Employee</option>
                  <option value="Customer">Customer</option>
                </select>
              </div>
              <div className="form-group">
                <label>Requester Name *</label>
                <input type="text" value={formData.requester_name} onChange={(e) => setFormData({ ...formData, requester_name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Requester Email *</label>
                <input type="email" value={formData.requester_email} onChange={(e) => setFormData({ ...formData, requester_email: e.target.value })} required />
              </div>
            </div>

            <div className="form-group">
              <label>SLA Policy *</label>
              <select value={formData.sla_policy_id} onChange={(e) => setFormData({ ...formData, sla_policy_id: e.target.value })} required>
                <option value="">-- Select SLA --</option>
                {slaPolices.map(s => <option key={s.id} value={s.id}>{s.name} ({s.response_time_hours}h response / {s.resolution_time_hours}h resolution)</option>)}
              </select>
            </div>

            <button type="submit" className="primary-btn">Create Ticket</button>
          </form>
        </div>
      )}

      <div className="filters">
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All Status</option>
          <option value="Open">Open</option>
          <option value="In_Progress">In Progress</option>
          <option value="Waiting">Waiting</option>
          <option value="Resolved">Resolved</option>
          <option value="Closed">Closed</option>
        </select>
        <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
          <option value="">All Priorities</option>
          <option value="Low">Low</option>
          <option value="Medium">Medium</option>
          <option value="High">High</option>
          <option value="Critical">Critical</option>
        </select>
      </div>

      <div className="widget">
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticket #</th>
              <th>Subject</th>
              <th>Category</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Requester</th>
              <th>Due Date</th>
              <th>SLA</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map(ticket => (
              <tr key={ticket.id} onClick={() => fetchTicketDetail(ticket.id)} style={{ cursor: 'pointer' }}>
                <td>{ticket.ticket_number}</td>
                <td>{ticket.subject}</td>
                <td>{ticket.category_name}</td>
                <td><span className="priority-badge" style={{ background: getPriorityColor(ticket.priority) }}>{ticket.priority}</span></td>
                <td><span className={`status-badge ${ticket.status.toLowerCase()}`}>{ticket.status.replace('_', ' ')}</span></td>
                <td>{ticket.requester_name}</td>
                <td className={isOverdue(ticket) ? 'overdue' : ''}>{new Date(ticket.resolution_due_at).toLocaleDateString()}</td>
                <td>{ticket.is_sla_breached ? <span className="sla-breach">⚠️ Breached</span> : '✓'}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {ticket.status === 'Open' && (
                    <button className="action-btn" onClick={() => handleStatusChange(ticket.id, 'In_Progress')}>Start</button>
                  )}
                  {ticket.status === 'In_Progress' && (
                    <button className="action-btn" onClick={() => handleStatusChange(ticket.id, 'Resolved')}>Resolve</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showDetail && selectedTicket && (
        <div className="ticket-detail-modal" onClick={() => setShowDetail(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{selectedTicket.ticket_number} - {selectedTicket.subject}</h2>
              <button onClick={() => setShowDetail(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="ticket-info">
                <p><strong>Category:</strong> {selectedTicket.category_name}</p>
                <p><strong>Priority:</strong> <span style={{ color: getPriorityColor(selectedTicket.priority) }}>{selectedTicket.priority}</span></p>
                <p><strong>Status:</strong> {selectedTicket.status}</p>
                <p><strong>Description:</strong> {selectedTicket.description}</p>
              </div>

              <div className="conversations">
                <h3>Conversations</h3>
                {conversations.map(conv => (
                  <div key={conv.id} className="conversation-item">
                    <div className="conv-header">
                      <strong>{conv.created_by_name}</strong>
                      <span>{new Date(conv.created_at).toLocaleString()}</span>
                    </div>
                    <p>{conv.message}</p>
                  </div>
                ))}
              </div>

              <div className="add-conversation">
                <textarea value={newMessage} onChange={(e) => setNewMessage(e.target.value)} placeholder="Add a reply..." rows="3"></textarea>
                <button className="primary-btn" onClick={handleAddConversation}>Send</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
