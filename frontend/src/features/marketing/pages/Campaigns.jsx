import React, { useState, useEffect } from 'react';
import axios from 'axios';
import '../../crm/pages/Leads.css';

const Campaigns = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    campaign_name: '',
    campaign_type: 'email',
    start_date: '',
    end_date: '',
    budget: '',
    expected_leads: '',
    status: 'planned',
    description: ''
  });

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/marketing/campaigns', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCampaigns(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/marketing/campaigns', formData, {
        headers: { Authorization: `Bearer ${token}` }
      });
      alert('Campaign created successfully');
      setShowForm(false);
      fetchCampaigns();
      setFormData({
        campaign_name: '',
        campaign_type: 'email',
        start_date: '',
        end_date: '',
        budget: '',
        expected_leads: '',
        status: 'planned',
        description: ''
      });
    } catch (error) {
      alert('Error creating campaign');
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      planned: '#f3f4f6',
      active: '#dcfce7',
      paused: '#fef3c7',
      completed: '#dbeafe',
      cancelled: '#fee2e2'
    };
    return colors[status] || '#f3f4f6';
  };

  const getTypeColor = (type) => {
    const colors = {
      email: '#dbeafe',
      linkedin: '#e0e7ff',
      google_ads: '#fef3c7',
      facebook: '#fce7f3',
      event: '#dcfce7',
      webinar: '#fed7aa'
    };
    return colors[type] || '#f3f4f6';
  };

  return (
    <div className="leads-page">
      <div className="leads-header">
        <h1>Marketing Campaigns</h1>
        <button className="primary-btn" onClick={() => setShowForm(true)}>+ New Campaign</button>
      </div>

      {showForm && (
        <div className="form-modal">
          <div className="form-card">
            <h2>Create Campaign</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Campaign Name *</label>
                <input
                  type="text"
                  value={formData.campaign_name}
                  onChange={(e) => setFormData({ ...formData, campaign_name: e.target.value })}
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Campaign Type</label>
                  <select
                    value={formData.campaign_type}
                    onChange={(e) => setFormData({ ...formData, campaign_type: e.target.value })}
                  >
                    <option value="email">Email</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="google_ads">Google Ads</option>
                    <option value="facebook">Facebook</option>
                    <option value="event">Event</option>
                    <option value="webinar">Webinar</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  >
                    <option value="planned">Planned</option>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Start Date *</label>
                  <input
                    type="date"
                    value={formData.start_date}
                    onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>End Date</label>
                  <input
                    type="date"
                    value={formData.end_date}
                    onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Budget</label>
                  <input
                    type="number"
                    value={formData.budget}
                    onChange={(e) => setFormData({ ...formData, budget: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Expected Leads</label>
                  <input
                    type="number"
                    value={formData.expected_leads}
                    onChange={(e) => setFormData({ ...formData, expected_leads: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows="3"
                />
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Create Campaign</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="leads-table-container">
        <table className="leads-table">
          <thead>
            <tr>
              <th>Campaign Name</th>
              <th>Type</th>
              <th>Start Date</th>
              <th>Budget</th>
              <th>Expected Leads</th>
              <th>Actual Leads</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map(campaign => (
              <tr key={campaign.id}>
                <td><strong>{campaign.campaign_name}</strong></td>
                <td>
                  <span className="badge" style={{ background: getTypeColor(campaign.campaign_type) }}>
                    {campaign.campaign_type.replace('_', ' ')}
                  </span>
                </td>
                <td>{new Date(campaign.start_date).toLocaleDateString()}</td>
                <td>₹{parseFloat(campaign.budget || 0).toLocaleString()}</td>
                <td>{campaign.expected_leads || 0}</td>
                <td>{campaign.actual_leads || 0}</td>
                <td>
                  <span className="badge" style={{ background: getStatusColor(campaign.status) }}>
                    {campaign.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Campaigns;
