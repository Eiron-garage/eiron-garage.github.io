// ===== הגדרות המוסך =====
// 1. מדביקים כאן את ה-firebaseConfig מ: Firebase → Project settings → Your apps → Web app
//    (המידע הזה לא סודי — האבטחה נעשית ע"י הסיסמה והחוקים ב-firestore.rules)
window.FIREBASE_CONFIG = null;
/* דוגמה:
window.FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "my-garage.firebaseapp.com",
  projectId: "my-garage",
  storageBucket: "my-garage.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef"
};
*/

// 2. כתובת המייל של חשבון המוסך שיצרתם ב-Firebase → Authentication → Users
//    (העובדים יצטרכו להקליד רק את הסיסמה)
window.GARAGE_LOGIN_EMAIL = '';

// 3. שם המוסך שיופיע בראש המסך
window.GARAGE_NAME = 'סטטוס רכבים במוסך';
