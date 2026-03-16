import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import './Quotations.css';

const Quotations = () => {
  const [quotations, setQuotations] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [formData, setFormData] = useState({
    quotation_number: '',
    customer_id: '',
    quotation_date: new Date().toISOString().split('T')[0],
    validity_date: '',
    status: 'draft',
    notes: '',
    tax_rate: 18,
    discount: 0
  });

  useEffect(() => {
    fetchQuotations();
    fetchCustomers();
    fetchProducts();
  }, []);

  const fetchQuotations = async () => {
    try {
      const res = await api.get('/sales/quotations');
      setQuotations(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchCustomers = async () => {
    try {
      const res = await api.get('/finance/parties?type=customer');
      setCustomers(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchProducts = async () => {
    try {
      const res = await api.get('/inventory/items');
      setProducts(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleNewQuotation = async () => {
    try {
      const res = await api.get('/sales/quotations/next-number');
      setFormData({ ...formData, quotation_number: res.data.number });
      setSelectedProducts([]);
      setShowForm(true);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const addProduct = () => {
    setSelectedProducts([...selectedProducts, { product_id: '', quantity: 1, unit_price: 0, description: '' }]);
  };

  const removeProduct = (index) => {
    setSelectedProducts(selectedProducts.filter((_, i) => i !== index));
  };

  const updateProduct = (index, field, value) => {
    const updated = [...selectedProducts];
    updated[index][field] = value;
    if (field === 'product_id') {
      const product = products.find(p => p.id === parseInt(value));
      if (product) {
        updated[index].unit_price = product.unit_price || 0;
        updated[index].description = product.item_name;
      }
    }
    setSelectedProducts(updated);
  };

  const calculateTotals = () => {
    const subtotal = selectedProducts.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    const discount = (subtotal * formData.discount) / 100;
    const taxable = subtotal - discount;
    const tax = (taxable * formData.tax_rate) / 100;
    const total = taxable + tax;
    return { subtotal, discount, tax, total };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const totals = calculateTotals();
      await api.post('/sales/quotations', {
        ...formData,
        items: selectedProducts,
        subtotal: totals.subtotal,
        discount_amount: totals.discount,
        tax_amount: totals.tax,
        total_amount: totals.total
      });
      alert('Quotation created successfully');
      setShowForm(false);
      fetchQuotations();
    } catch (error) {
      alert('Error creating quotation');
    }
  };

  const downloadPDF = async (quotationId) => {
    try {
      const res = await api.get(`/sales/quotations/${quotationId}/pdf`, {
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `quotation-${quotationId}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      alert('Error downloading PDF');
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      draft: '#f3f4f6',
      sent: '#dbeafe',
      accepted: '#dcfce7',
      rejected: '#fee2e2',
      expired: '#fef3c7'
    };
    return colors[status] || '#f3f4f6';
  };

  return (
    <div className="leads-page">
      <div className="leads-header">
        <h1>Quotations</h1>
        <button className="primary-btn" onClick={handleNewQuotation}>+ New Quotation</button>
      </div>

      {showForm && (
        <div className="form-modal">
          <div className="form-card">
            <h2 style={{ marginTop: 0 }}>Create Quotation</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Quotation Number</label>
                <input type="text" value={formData.quotation_number} readOnly />
              </div>

              <div className="form-group">
                <label>Customer *</label>
                <select
                  value={formData.customer_id}
                  onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                  required
                >
                  <option value="">Select Customer</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Quotation Date *</label>
                  <input
                    type="date"
                    value={formData.quotation_date}
                    onChange={(e) => setFormData({ ...formData, quotation_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Validity Date *</label>
                  <input
                    type="date"
                    value={formData.validity_date}
                    onChange={(e) => setFormData({ ...formData, validity_date: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows="3"
                />
              </div>

              <div style={{ marginTop: '20px', marginBottom: '15px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '20px' }}>Products</h3>
                  <button type="button" className="primary-btn" onClick={addProduct}>+ Add Product</button>
                </div>
                {selectedProducts.map((item, index) => (
                  <div key={index} style={{ background: '#f9fafb', padding: '15px', borderRadius: '8px', marginBottom: '10px', border: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '10px', alignItems: 'end' }}>
                      <div>
                        <label style={{ fontSize: '14px', fontWeight: '600' }}>Product</label>
                        <select value={item.product_id} onChange={(e) => updateProduct(index, 'product_id', e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e5e7eb' }}>
                          <option value="">Select Product</option>
                          {products.map(p => (
                            <option key={p.id} value={p.id}>{p.item_name} - ₹{p.unit_price}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: '14px', fontWeight: '600' }}>Quantity</label>
                        <input type="number" value={item.quantity} onChange={(e) => updateProduct(index, 'quantity', e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e5e7eb' }} />
                      </div>
                      <div>
                        <label style={{ fontSize: '14px', fontWeight: '600' }}>Price</label>
                        <input type="number" value={item.unit_price} onChange={(e) => updateProduct(index, 'unit_price', e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e5e7eb' }} />
                      </div>
                      <button type="button" onClick={() => removeProduct(index)} style={{ padding: '8px 12px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>✕</button>
                    </div>
                    <div style={{ marginTop: '10px', fontSize: '16px', fontWeight: '600' }}>Total: ₹{(item.quantity * item.unit_price).toFixed(2)}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: 'var(--bg-color)', padding: '15px', borderRadius: '8px', marginBottom: '15px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span>Subtotal:</span>
                  <strong>₹{calculateTotals().subtotal.toFixed(2)}</strong>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
                  <label>Discount %:</label>
                  <input type="number" value={formData.discount} onChange={(e) => setFormData({ ...formData, discount: e.target.value })} style={{ width: '80px', padding: '4px', borderRadius: '4px', border: '1px solid #e5e7eb' }} />
                  <span>₹{calculateTotals().discount.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
                  <label>Tax %:</label>
                  <input type="number" value={formData.tax_rate} onChange={(e) => setFormData({ ...formData, tax_rate: e.target.value })} style={{ width: '80px', padding: '4px', borderRadius: '4px', border: '1px solid #e5e7eb' }} />
                  <span>₹{calculateTotals().tax.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '20px', fontWeight: '700', color: 'var(--primary-color)', paddingTop: '10px', borderTop: '2px solid #e5e7eb' }}>
                  <span>Total:</span>
                  <span>₹{calculateTotals().total.toFixed(2)}</span>
                </div>
              </div>

              <div className="form-actions">
                <button type="button" className="secondary-btn" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Create Quotation</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="leads-table-container">
        <table className="leads-table">
          <thead>
            <tr>
              <th>Quotation #</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Validity</th>
              <th>Total Amount</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {quotations.map(quot => (
              <tr key={quot.id}>
                <td><strong>{quot.quotation_number}</strong></td>
                <td>{quot.customer_name}</td>
                <td>{new Date(quot.quotation_date).toLocaleDateString()}</td>
                <td>{new Date(quot.validity_date).toLocaleDateString()}</td>
                <td>₹{parseFloat(quot.total_amount || 0).toLocaleString()}</td>
                <td>
                  <span className="badge" style={{ background: getStatusColor(quot.status) }}>
                    {quot.status}
                  </span>
                </td>
                <td>
                  <button className="secondary-btn" onClick={() => downloadPDF(quot.id)} style={{ padding: '6px 12px', fontSize: '14px' }}>
                    📄 Download PDF
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Quotations;
