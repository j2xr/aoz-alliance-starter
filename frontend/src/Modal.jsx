import {} from "react";

function Modal({ onClose, children }) {
  return (
    <div style={{ position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,0.82)",
      backdropFilter:"blur(5px)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem" }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background:"#0f111a",border:"1px solid #2a2d3e",borderRadius:"16px",
        padding:"2rem",width:"100%",maxWidth:"500px",maxHeight:"90vh",overflowY:"auto",
        boxShadow:"0 0 80px rgba(255,215,0,0.07)"
      }}>
        {children}
      </div>
    </div>
  );
}

export default Modal;
