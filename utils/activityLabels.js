// Canonical activity-type → human label map. Single source of truth for activity
// wording so the SAME event reads identically across backend, admin panel and mobile.
// KEEP IN SYNC with the mobile copy at ram-counter-mobile/src/config/activityLabels.js.
const ACTIVITY_LABELS = {
  REGISTER: 'User Registered',
  LOGIN: 'Login Successful',
  LOGOUT: 'Logout',
  PROFILE_UPDATE: 'Profile Updated',
  APPROVAL: 'User Approved',
  REJECTION: 'User Rejected / Deactivated',
  DAILY_RESET: 'Daily Count Reset',
  COUNT_INCREMENT: 'Chant Recorded', // normally hidden from the feed
  // Admin audit actions
  DELETE_USER: 'User Deleted',
  RESTORE_USER: 'User Restored',
  DEACTIVATE_USER: 'User Deactivated',
  EDIT_USER: 'User Edited',
  STATUS_CHANGE: 'Status Changed',
  SET_COUNT: 'Count Updated',
  RECONCILE_COUNTS: 'Counts Reconciled',
  CHANGE_PASSWORD: 'Admin Password Changed',
};

function activityLabel(type) {
  return ACTIVITY_LABELS[type] || type || 'Activity';
}

module.exports = { ACTIVITY_LABELS, activityLabel };
