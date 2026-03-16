import React from 'react';

export { default as SupportDashboard } from './SupportDashboard';
export { default as AllTickets } from './AllTickets';
export { default as TicketDetail } from './TicketDetail';
export { default as AgentWorkload } from './AgentWorkload';
export { default as ServiceEngineers } from './ServiceEngineers';
export { default as FieldVisitScheduler } from './FieldVisitScheduler';

// Placeholders for other pages to prevent import errors
export const MyTickets = () => <div>My Tickets Page</div>;
export const FieldService = () => <div>Field Service Page</div>;
export const KnowledgeBase = () => <div>Knowledge Base Page</div>;
export const ServiceContracts = () => <div>Service Contracts Page</div>;