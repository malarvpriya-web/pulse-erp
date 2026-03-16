import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './Recruitment.css';

const EmailTemplates = () => {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [formData, setFormData] = useState({
    template_name: '',
    template_type: 'application_received',
    subject: '',
    body_html: '',
    variables_json: '{}',
    is_active: true
  });

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/recruitment/email-templates', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTemplates(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      if (editingTemplate) {
        await axios.put(`http://localhost:5000/api/recruitment/email-templates/${editingTemplate.id}`,
          formData,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        alert('Template updated successfully');
      } else {
        await axios.post('http://localhost:5000/api/recruitment/email-templates',
          formData,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        alert('Template created successfully');
      }
      setShowForm(false);
      setEditingTemplate(null);
      resetForm();
      fetchTemplates();
    } catch (error) {
      alert('Error saving template');
    }
  };

  const handleEdit = (template) => {
    setEditingTemplate(template);
    setFormData({
      template_name: template.template_name,
      template_type: template.template_type,
      subject: template.subject,
      body_html: template.body_html,
      variables_json: JSON.stringify(template.variables_json || {}),
      is_active: template.is_active
    });
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this template?')) return;
    try {
      const token = localStorage.getItem('token');
      await axios.delete(`http://localhost:5000/api/recruitment/email-templates/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      alert('Template deleted successfully');
      fetchTemplates();
    } catch (error) {
      alert('Error deleting template');
    }
  };

  const toggleActive = async (id, currentStatus) => {
    try {
      const token = localStorage.getItem('token');
      await axios.put(`http://localhost:5000/api/recruitment/email-templates/${id}`,
        { is_active: !currentStatus },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      fetchTemplates();
    } catch (error) {
      alert('Error updating template status');
    }
  };

  const resetForm = () => {
    setFormData({
      template_name: '',
      template_type: 'application_received',
      subject: '',
      body_html: '',
      variables_json: '{}',
      is_active: true
    });
  };

  const templateTypes = [
    { value: 'application_received', label: 'Application Received' },
    { value: 'interview_scheduled', label: 'Interview Scheduled' },
    { value: 'interview_reminder', label: 'Interview Reminder' },
    { value: 'rejection', label: 'Rejection Email' },
    { value: 'offer_letter', label: 'Offer Letter' },
    { value: 'joining_instructions', label: 'Joining Instructions' }
  ];

  return (
    <div className="recruitment-page">
      <div className="page-header">
        <div>
          <button className="back-btn" onClick={() => navigate('/recruitment/dashboard')}>← Back</button>
          <h1>Email Templates</h1>
        </div>
        <button className="primary-btn" onClick={() => { setShowForm(true); setEditingTemplate(null); resetForm(); }}>
          + New Template
        </button>
      </div>

      {showForm && (
        <div className="modal-overlay">
          <div className="modal-content large">
            <h2>{editingTemplate ? 'Edit Template' : 'Create Email Template'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Template Name *</label>
                  <input
                    type="text"
                    value={formData.template_name}
                    onChange={(e) => setFormData({ ...formData, template_name: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Template Type *</label>
                  <select
                    value={formData.template_type}
                    onChange={(e) => setFormData({ ...formData, template_type: e.target.value })}
                    required
                  >
                    {templateTypes.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Subject *</label>
                <input
                  type="text"
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  placeholder="Use {{variable_name}} for dynamic content"
                  required
                />
              </div>

              <div className="form-group">
                <label>Email Body (HTML) *</label>
                <textarea
                  value={formData.body_html}
                  onChange={(e) => setFormData({ ...formData, body_html: e.target.value })}
                  rows="10"
                  placeholder="Use {{candidate_name}}, {{job_title}}, {{interview_date}}, etc."
                  required
                />
              </div>

              <div className="form-group">
                <label>Variables (JSON)</label>
                <textarea
                  value={formData.variables_json}
                  onChange={(e) => setFormData({ ...formData, variables_json: e.target.value })}
                  rows="3"
                  placeholder='{"candidate_name": "string", "job_title": "string"}'
                />
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                  />
                  Active
                </label>
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => { setShowForm(false); setEditingTemplate(null); resetForm(); }}>
                  Cancel
                </button>
                <button type="submit" className="submit-btn">
                  {editingTemplate ? 'Update' : 'Create'} Template
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="templates-grid">
        {templates.map(template => (
          <div key={template.id} className={`template-card ${!template.is_active ? 'inactive' : ''}`}>
            <div className="template-header">
              <h3>{template.template_name}</h3>
              <div className="template-actions">
                <button 
                  className={`toggle-btn ${template.is_active ? 'active' : ''}`}
                  onClick={() => toggleActive(template.id, template.is_active)}
                >
                  {template.is_active ? '✓' : '✗'}
                </button>
              </div>
            </div>
            <div className="template-type">
              <span className="type-badge">{template.template_type.replace(/_/g, ' ')}</span>
            </div>
            <div className="template-subject">
              <strong>Subject:</strong> {template.subject}
            </div>
            <div className="template-body">
              {template.body_html.substring(0, 150)}...
            </div>
            <div className="template-footer">
              <button className="action-btn" onClick={() => handleEdit(template)}>Edit</button>
              <button className="action-btn danger" onClick={() => handleDelete(template.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {templates.length === 0 && (
        <div className="empty-state">
          <p>No email templates found. Create your first template!</p>
        </div>
      )}

      <div className="info-section">
        <h3>Available Variables</h3>
        <div className="variables-list">
          <code>{'{{candidate_name}}'}</code>
          <code>{'{{candidate_email}}'}</code>
          <code>{'{{job_title}}'}</code>
          <code>{'{{interview_date}}'}</code>
          <code>{'{{interview_time}}'}</code>
          <code>{'{{meeting_link}}'}</code>
          <code>{'{{company_name}}'}</code>
        </div>
      </div>
    </div>
  );
};

export default EmailTemplates;
